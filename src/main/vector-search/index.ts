import { Worker } from 'worker_threads';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import * as codeSearchRepo from '../repositories/code-search';
import { getEmbeddingProvider, disposeEmbeddingProvider } from './embedding-provider';
import { ParsedSymbol } from './parser';
import type { CodeIndex, IndexProgress, CodeSearchResult, SymbolSearchResult, SymbolType } from '../../shared/types';

interface WorkerResult {
  type: 'progress' | 'file-parsed' | 'complete' | 'error';
  indexId: string;
  progress?: IndexProgress;
  fileData?: {
    filePath: string;
    relativePath: string;
    mtime: number;
    chunks: Array<{
      content: string;
      startLine: number;
      endLine: number;
      chunkType: string | null;
    }>;
    symbols: ParsedSymbol[];
  };
  error?: string;
}

export class VectorSearchManager extends EventEmitter {
  private workers: Map<string, Worker> = new Map();
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingFiles: Map<string, WorkerResult['fileData'][]> = new Map();

  constructor() {
    super();
  }

  // ============ Index Management ============

  async getOrCreateIndex(directoryPath: string): Promise<CodeIndex> {
    let index = codeSearchRepo.getIndexByDirectory(directoryPath);

    if (!index) {
      index = codeSearchRepo.createIndex(directoryPath);
    }

    return index;
  }

  async startIndexing(directoryPath: string): Promise<void> {
    const index = await this.getOrCreateIndex(directoryPath);

    // Cancel any existing indexing for this directory
    this.cancelIndexing(index.id);

    // Update status
    codeSearchRepo.updateIndexStatus(index.id, 'indexing');

    // Initialize pending files queue
    this.pendingFiles.set(index.id, []);

    // Start worker
    const workerPath = path.join(__dirname, 'indexing-worker.js');
    const worker = new Worker(workerPath);

    this.workers.set(index.id, worker);

    worker.on('message', (result: WorkerResult) => {
      this.handleWorkerMessage(index.id, result);
    });

    worker.on('error', (err) => {
      console.error('Worker error:', err);
      codeSearchRepo.updateIndexStatus(index.id, 'error', err.message);
      this.workers.delete(index.id);
      this.pendingFiles.delete(index.id);
    });

    worker.on('exit', (code) => {
      this.workers.delete(index.id);
      if (code !== 0) {
        codeSearchRepo.updateIndexStatus(index.id, 'error', `Worker exited with code ${code}`);
      }
    });

    worker.postMessage({
      type: 'start',
      indexId: index.id,
      directoryPath,
    });
  }

  cancelIndexing(indexId: string): void {
    const worker = this.workers.get(indexId);
    if (worker) {
      worker.postMessage({ type: 'cancel' });
      worker.terminate();
      this.workers.delete(indexId);
    }
    this.pendingFiles.delete(indexId);
  }

  private handleWorkerMessage(indexId: string, result: WorkerResult): void {
    switch (result.type) {
      case 'progress':
        this.emit('indexing-progress', result.progress);
        break;

      case 'file-parsed':
        // Queue file for embedding generation
        const pending = this.pendingFiles.get(indexId);
        if (pending && result.fileData) {
          pending.push(result.fileData);
          // Process in batches to avoid blocking
          if (pending.length >= 5) {
            this.processPendingFiles(indexId);
          }
        }
        break;

      case 'complete':
        // Process any remaining files
        this.processPendingFiles(indexId).then(() => {
          this.handleIndexingComplete(indexId);
        });
        break;

      case 'error':
        codeSearchRepo.updateIndexStatus(indexId, 'error', result.error ?? 'Unknown error');
        this.emit('indexing-error', { indexId, error: result.error });
        this.pendingFiles.delete(indexId);
        break;
    }
  }

  private async processPendingFiles(indexId: string): Promise<void> {
    const pending = this.pendingFiles.get(indexId);
    if (!pending || pending.length === 0) return;

    // Take all pending files
    const files = pending.splice(0, pending.length);

    const provider = getEmbeddingProvider();

    for (const fileData of files) {
      try {
        await this.processFileWithEmbeddings(indexId, fileData, provider);
      } catch (err) {
        console.error(`Error processing file ${fileData.filePath}:`, err);
      }
    }
  }

  private async processFileWithEmbeddings(
    indexId: string,
    fileData: NonNullable<WorkerResult['fileData']>,
    provider: ReturnType<typeof getEmbeddingProvider>
  ): Promise<void> {
    const { filePath, mtime, chunks, symbols } = fileData;

    // Delete existing data for this file
    codeSearchRepo.deleteChunksByFile(indexId, filePath);
    codeSearchRepo.deleteSymbolsByFile(indexId, filePath);

    // Generate embeddings and insert chunks
    for (const chunk of chunks) {
      try {
        const [embedding] = await provider.embed([chunk.content]);

        codeSearchRepo.createChunk(
          indexId,
          filePath,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.chunkType as any,
          embedding
        );
      } catch (err) {
        // Insert chunk without embedding if embedding fails
        codeSearchRepo.createChunk(
          indexId,
          filePath,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.chunkType as any,
          null
        );
      }
    }

    // Insert symbols
    const symbolIdMap = new Map<string, string>();
    for (const symbol of symbols) {
      const parentId = symbol.parentName ? symbolIdMap.get(symbol.parentName) : null;
      const created = codeSearchRepo.createSymbol(
        indexId,
        symbol.name,
        symbol.symbolType,
        filePath,
        symbol.line,
        symbol.column,
        symbol.signature,
        parentId
      );
      symbolIdMap.set(symbol.name, created.id);
    }

    // Update file record
    codeSearchRepo.upsertIndexedFile(indexId, filePath, mtime);
    codeSearchRepo.updateFileChunkCount(indexId, filePath, chunks.length);
  }

  private handleIndexingComplete(indexId: string): void {
    // Update counts
    const index = codeSearchRepo.getIndexById(indexId);
    if (index) {
      const files = codeSearchRepo.getIndexedFiles(indexId);
      const chunkCount = files.reduce((sum, f) => sum + f.chunkCount, 0);
      codeSearchRepo.updateIndexCounts(indexId, files.length, chunkCount);
    }

    codeSearchRepo.updateIndexStatus(indexId, 'ready');
    this.emit('indexing-complete', { indexId });
    this.pendingFiles.delete(indexId);

    // Start file watcher
    if (index) {
      this.startWatching(index.directoryPath, indexId);
    }
  }

  // ============ File Watching ============

  startWatching(directoryPath: string, indexId: string): void {
    if (this.watchers.has(indexId)) return;

    const watcher = chokidar.watch(directoryPath, {
      ignored: /(^|[\/\\])\.|node_modules|dist|build/,
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on('change', (filePath) => {
      this.handleFileChange(indexId, filePath);
    });

    watcher.on('add', (filePath) => {
      this.handleFileChange(indexId, filePath);
    });

    watcher.on('unlink', (filePath) => {
      this.handleFileDelete(indexId, filePath);
    });

    this.watchers.set(indexId, watcher);
  }

  stopWatching(indexId: string): void {
    const watcher = this.watchers.get(indexId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(indexId);
    }
  }

  private handleFileChange(indexId: string, filePath: string): void {
    // Debounce changes
    const key = `${indexId}:${filePath}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      this.reindexFile(indexId, filePath);
    }, 500));
  }

  private handleFileDelete(indexId: string, filePath: string): void {
    codeSearchRepo.deleteChunksByFile(indexId, filePath);
    codeSearchRepo.deleteSymbolsByFile(indexId, filePath);
    codeSearchRepo.deleteIndexedFile(indexId, filePath);
  }

  private async reindexFile(indexId: string, filePath: string): Promise<void> {
    // For now, just emit an event - full single-file reindexing would need
    // to import and use the parsing logic directly
    this.emit('file-changed', { indexId, filePath });
  }

  // ============ Search ============

  async searchCode(
    directoryPath: string,
    query: string,
    limit: number = 10
  ): Promise<CodeSearchResult[]> {
    const index = codeSearchRepo.getIndexByDirectory(directoryPath);
    if (!index || index.status !== 'ready') {
      return [];
    }

    // Generate query embedding
    const provider = getEmbeddingProvider();
    const [queryEmbedding] = await provider.embed([query]);

    return codeSearchRepo.searchChunksByVector(index.id, queryEmbedding, limit);
  }

  searchSymbols(
    directoryPath: string,
    name: string,
    symbolType?: SymbolType,
    limit: number = 20
  ): SymbolSearchResult[] {
    const index = codeSearchRepo.getIndexByDirectory(directoryPath);
    if (!index || index.status !== 'ready') {
      return [];
    }

    return codeSearchRepo.searchSymbols(index.id, name, symbolType, limit);
  }

  getIndexStatus(directoryPath: string): CodeIndex | null {
    return codeSearchRepo.getIndexByDirectory(directoryPath);
  }

  getAllIndexes(): CodeIndex[] {
    return codeSearchRepo.getAllIndexes();
  }

  deleteIndex(directoryPath: string): void {
    const index = codeSearchRepo.getIndexByDirectory(directoryPath);
    if (index) {
      this.stopWatching(index.id);
      this.cancelIndexing(index.id);
      codeSearchRepo.deleteIndex(index.id);
    }
  }

  // ============ Cleanup ============

  dispose(): void {
    for (const [id, worker] of this.workers) {
      worker.terminate();
    }
    this.workers.clear();

    for (const [id, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.pendingFiles.clear();

    disposeEmbeddingProvider();
  }
}

// Singleton instance
let manager: VectorSearchManager | null = null;

export function getVectorSearchManager(): VectorSearchManager {
  if (!manager) {
    manager = new VectorSearchManager();
  }
  return manager;
}

export function disposeVectorSearchManager(): void {
  if (manager) {
    manager.dispose();
    manager = null;
  }
}
