import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { app } from 'electron';
import log from 'electron-log';
import * as codeSearchRepo from '../repositories/code-search';
import { getEmbeddingProvider, EMBEDDING_VERSION } from './embedding-provider';
import { ParsedSymbol } from './parser';
import type { CodeIndex, IndexProgress, CodeSearchResult, SymbolSearchResult, SymbolType, IndexStatus, IndexPhase } from '../../shared/types';

// Worker progress now includes phase since worker handles both parsing and embedding
interface WorkerProgress {
  indexId: string;
  directoryPath: string;
  status: IndexStatus;
  phase: IndexPhase;
  filesTotal: number;
  filesIndexed: number;
  currentFile: string | null;
  error: string | null;
}

interface WorkerResult {
  type: 'progress' | 'file-parsed' | 'complete' | 'error';
  indexId: string;
  progress?: WorkerProgress;
  fileData?: {
    filePath: string;
    relativePath: string;
    mtime: number;
    chunks: Array<{
      content: string;
      startLine: number;
      endLine: number;
      chunkType: string | null;
      embedding: number[] | null; // Embeddings now come from worker
    }>;
    symbols: ParsedSymbol[];
  };
  error?: string;
}

// Timeout for model initialization (downloading 110MB model + loading ONNX runtime)
const WORKER_INIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// BDHLNDR-40: a native crash in the indexing worker_thread kills the whole
// process silently — no exit/error handler runs, so status stays 'indexing'
// in the DB. The renderer auto-restarts indexing on a stale 'indexing' status,
// producing an infinite crash-relaunch loop. After this many consecutive
// crashed attempts we trip a circuit breaker and stop auto-spawning the worker
// (status → 'error', user can still explicitly retry). 2 = allow one automatic
// retry, then break the loop.
const MAX_CONSECUTIVE_INDEX_CRASHES = 2;

export class VectorSearchManager extends EventEmitter {
  private workers: Map<string, Worker> = new Map();
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private cancelledIndexes: Set<string> = new Set();
  private workerTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    super();
  }

  /**
   * Get the path to the indexing worker script.
   * Worker threads cannot load from inside asar archives, so in packaged
   * builds we resolve to the app.asar.unpacked directory.
   */
  private getWorkerPath(): string {
    if (!app.isPackaged) {
      return path.join(__dirname, 'indexing-worker.js');
    }

    // In production, use the unpacked path
    const unpackedPath = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'dist',
      'main',
      'vector-search',
      'indexing-worker.js'
    );

    if (fs.existsSync(unpackedPath)) {
      return unpackedPath;
    }

    // Fallback to __dirname (will likely fail in asar, but log will show the issue)
    console.warn('[VectorSearch] Unpacked worker not found at:', unpackedPath);
    return path.join(__dirname, 'indexing-worker.js');
  }

  // ============ Index Management ============

  async getOrCreateIndex(directoryPath: string): Promise<CodeIndex> {
    let index = codeSearchRepo.getIndexByDirectory(directoryPath);

    if (!index) {
      index = codeSearchRepo.createIndex(directoryPath);
    }

    return index;
  }

  /**
   * Check if index needs reconciliation (files changed since indexing).
   * Returns list of files that need re-indexing.
   */
  async checkReconciliation(directoryPath: string): Promise<{
    needsReindex: boolean;
    changedFiles: string[];
    deletedFiles: string[];
  }> {
    const index = codeSearchRepo.getIndexByDirectory(directoryPath);
    if (!index || index.status !== 'ready') {
      return { needsReindex: false, changedFiles: [], deletedFiles: [] };
    }

    const indexedFiles = codeSearchRepo.getIndexedFiles(index.id);
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const file of indexedFiles) {
      try {
        const stats = await fs.promises.stat(file.filePath);
        const currentMtime = Math.floor(stats.mtimeMs);

        if (currentMtime > file.mtime) {
          changedFiles.push(file.filePath);
        }
      } catch {
        // File no longer exists
        deletedFiles.push(file.filePath);
      }
    }

    return {
      needsReindex: changedFiles.length > 0 || deletedFiles.length > 0,
      changedFiles,
      deletedFiles,
    };
  }

  /**
   * Reconcile index by removing deleted files and marking for re-indexing.
   * Does not automatically re-index - caller should call startIndexing if needed.
   */
  async reconcileIndex(directoryPath: string): Promise<{
    filesRemoved: number;
    needsFullReindex: boolean;
  }> {
    const index = codeSearchRepo.getIndexByDirectory(directoryPath);
    if (!index) {
      return { filesRemoved: 0, needsFullReindex: false };
    }

    const { changedFiles, deletedFiles } = await this.checkReconciliation(directoryPath);

    // Remove deleted files from index
    for (const filePath of deletedFiles) {
      codeSearchRepo.deleteChunksByFile(index.id, filePath);
      codeSearchRepo.deleteSymbolsByFile(index.id, filePath);
      codeSearchRepo.deleteIndexedFile(index.id, filePath);
    }

    // Update counts after removing deleted files
    if (deletedFiles.length > 0) {
      const files = codeSearchRepo.getIndexedFiles(index.id);
      const chunkCount = files.reduce((sum, f) => sum + f.chunkCount, 0);
      codeSearchRepo.updateIndexCounts(index.id, files.length, chunkCount);
    }

    // If there are changed files, we need a full re-index
    // (incremental re-indexing would require more complex logic)
    const needsFullReindex = changedFiles.length > 0;

    if (needsFullReindex) {
      codeSearchRepo.updateIndexStatus(index.id, 'stale');
    }

    return {
      filesRemoved: deletedFiles.length,
      needsFullReindex,
    };
  }

  async startIndexing(directoryPath: string): Promise<void> {
    const index = await this.getOrCreateIndex(directoryPath);

    // If a worker is already running for this index, don't spawn another one.
    // Multiple renderer consumers (IndexStatus, CodeSearchModal) each mount
    // their own useCodeSearch hook, and on session switch each fires its own
    // auto-index effect — without this guard, concurrent workers race on
    // native module initialization (tree-sitter / onnxruntime-node) and
    // crash the process. (BDHLNDR-6 / root cause of BDHLNDR-3.)
    if (this.workers.has(index.id)) {
      console.log('[VectorSearch] Indexing already in progress for:', directoryPath);
      return;
    }

    // BDHLNDR-46: if this index's stored vectors were generated with a
    // different embedding version (e.g. fp32 from <= v3.3.1, now embedding at
    // q8), they are not comparable to new query vectors. Wipe and rebuild from
    // scratch rather than mixing incompatible vectors. Runs before the circuit
    // breaker below: clearIndexData resets status to 'pending', so a stale
    // 'indexing' from an old crash can't be miscounted as a fresh crash here.
    const persistedEmbeddingVersion = codeSearchRepo.getEmbeddingVersion(index.id);
    if (persistedEmbeddingVersion !== EMBEDDING_VERSION) {
      if ((index.chunkCount ?? 0) > 0) {
        log.warn(
          `[VectorSearch] Embedding version changed ` +
            `(${persistedEmbeddingVersion} → ${EMBEDDING_VERSION}) for ${directoryPath}; ` +
            `clearing stale vectors and re-indexing from scratch`
        );
        codeSearchRepo.clearIndexData(index.id, EMBEDDING_VERSION);
      } else {
        // Nothing indexed yet — just stamp the current embedding version.
        codeSearchRepo.setEmbeddingVersion(index.id, EMBEDDING_VERSION);
      }
    }

    // BDHLNDR-40 circuit breaker: a fresh status of 'indexing' here means a
    // previous attempt started but the process never reached a terminal state
    // (complete/error) — i.e. it crashed the whole process (native segfault in
    // the worker thread can't be caught in-process). In-process cancels are
    // excluded via cancelledIndexes; retryIndexing() sets 'pending' first so it
    // is never miscounted. Count consecutive crashes and stop auto-spawning the
    // worker once the threshold trips, so we don't relaunch-loop forever.
    const persisted = codeSearchRepo.getIndexById(index.id);
    if (persisted?.status === 'indexing' && !this.cancelledIndexes.has(index.id)) {
      const failures = codeSearchRepo.incrementConsecutiveFailures(index.id);
      if (failures >= MAX_CONSECUTIVE_INDEX_CRASHES) {
        const errorMsg =
          `Indexing disabled after ${failures} consecutive crashes. ` +
          `Use Retry to try again.`;
        log.error(
          `[VectorSearch] Circuit breaker tripped for ${directoryPath} — ${errorMsg}`
        );
        codeSearchRepo.updateIndexStatus(index.id, 'error', errorMsg);
        this.emit('indexing-error', {
          indexId: index.id,
          error: errorMsg,
          directoryPath: index.directoryPath,
        });
        return; // do NOT spawn the worker — breaks the crash-relaunch loop
      }
      log.warn(
        `[VectorSearch] Prior indexing attempt for ${directoryPath} did not ` +
          `complete (likely crashed); retry ${failures}/${MAX_CONSECUTIVE_INDEX_CRASHES}`
      );
    }

    // Clear the cancelled flag since we're starting fresh
    this.cancelledIndexes.delete(index.id);

    // Update status
    codeSearchRepo.updateIndexStatus(index.id, 'indexing');

    // Start worker - embeddings are now generated in the worker thread
    // In packaged apps, worker_threads cannot load from inside asar archives,
    // so we must use the unpacked path for both the script and module resolution
    const workerPath = this.getWorkerPath();
    const workerOptions: any = {};

    if (app.isPackaged) {
      // Worker's require() resolves modules from inside the asar by default.
      // Native modules (onnxruntime-node, etc.) are in app.asar.unpacked,
      // so we PREPEND the unpacked node_modules to NODE_PATH.
      // We must preserve existing NODE_PATH so the worker can still access
      // non-native modules from inside the asar archive.
      const unpackedModules = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules'
      );
      const asarModules = path.join(
        process.resourcesPath,
        'app.asar',
        'node_modules'
      );
      const existingNodePath = process.env.NODE_PATH || '';
      const pathSep = process.platform === 'win32' ? ';' : ':';
      // Prepend unpacked (for native), then asar (for regular modules)
      const newNodePath = [unpackedModules, asarModules, existingNodePath]
        .filter(Boolean)
        .join(pathSep);
      workerOptions.env = {
        ...process.env,
        NODE_PATH: newNodePath,
      };
    }

    // Capture worker stdout/stderr for debugging
    workerOptions.stdout = true;
    workerOptions.stderr = true;

    const worker = new Worker(workerPath, workerOptions);

    this.workers.set(index.id, worker);

    // Forward worker stdout/stderr to electron-log so they land in the log file
    if (worker.stdout) {
      worker.stdout.on('data', (data: Buffer) => {
        log.info('[VectorSearch Worker]', data.toString().trim());
      });
    }

    if (worker.stderr) {
      worker.stderr.on('data', (data: Buffer) => {
        log.error('[VectorSearch Worker]', data.toString().trim());
      });
    }

    worker.on('message', (result: WorkerResult) => {
      this.handleWorkerMessage(index.id, result);
    });

    worker.on('error', (err: Error) => {
      log.error('[VectorSearch] Worker error:', err);
      log.error('[VectorSearch] Worker error stack:', err.stack);
      const errorMsg = err.message || 'Worker thread error';
      codeSearchRepo.updateIndexStatus(index.id, 'error', errorMsg);
      this.workers.delete(index.id);
      this.emit('indexing-error', {
        indexId: index.id,
        error: errorMsg,
        directoryPath: index.directoryPath,
      });
    });

    worker.on('exit', (code) => {
      this.workers.delete(index.id);
      if (code !== 0 && !this.cancelledIndexes.has(index.id)) {
        const errorMsg = `Worker exited with code ${code}`;
        log.error('[VectorSearch]', errorMsg);
        codeSearchRepo.updateIndexStatus(index.id, 'error', errorMsg);
        this.emit('indexing-error', {
          indexId: index.id,
          error: errorMsg,
          directoryPath: index.directoryPath,
        });
      }
    });

    // Set a timeout for worker initialization (model download can take a while)
    const timeout = setTimeout(() => {
      if (this.workers.has(index.id)) {
        const errorMsg = 'Worker timed out during initialization (model download may have failed)';
        log.error('[VectorSearch]', errorMsg);
        // Fire-and-forget — the timeout handler isn't async. Termination
        // races are bounded here since we just update DB/emit after.
        void this.cancelIndexing(index.id);
        codeSearchRepo.updateIndexStatus(index.id, 'error', errorMsg);
        this.emit('indexing-error', {
          indexId: index.id,
          error: errorMsg,
          directoryPath: index.directoryPath,
        });
      }
    }, WORKER_INIT_TIMEOUT_MS);
    this.workerTimeouts.set(index.id, timeout);

    // Pass cache directory so the worker can configure model caching
    const cacheDir = path.join(app.getPath('userData'), 'huggingface');
    worker.postMessage({
      type: 'start',
      indexId: index.id,
      directoryPath,
      cacheDir,
    });
  }

  private clearWorkerTimeout(indexId: string): void {
    const timeout = this.workerTimeouts.get(indexId);
    if (timeout) {
      clearTimeout(timeout);
      this.workerTimeouts.delete(indexId);
    }
  }

  async cancelIndexing(indexId: string): Promise<void> {
    // Mark as cancelled so worker knows to stop
    this.cancelledIndexes.add(indexId);
    this.clearWorkerTimeout(indexId);

    const worker = this.workers.get(indexId);
    if (worker) {
      // Remove from the map synchronously so any concurrent startIndexing
      // correctly observes "no running worker" for this index.
      this.workers.delete(indexId);
      worker.postMessage({ type: 'cancel' });
      // Await termination so callers that immediately restart indexing
      // don't race with native-module init in the dying worker.
      try {
        await worker.terminate();
      } catch (err) {
        console.error('[VectorSearch] Error terminating worker:', err);
      }
    }
  }

  /**
   * Retry indexing after an error.
   * Clears the error state and restarts the indexing process.
   */
  async retryIndexing(directoryPath: string): Promise<void> {
    const index = codeSearchRepo.getIndexByDirectory(directoryPath);
    if (!index) {
      throw new Error('No index found for directory');
    }

    // Clear error state. BDHLNDR-40: an explicit user retry re-arms the
    // crash-loop circuit breaker from a clean count, and 'pending' (not
    // 'indexing') ensures startIndexing does not miscount this as a crash.
    codeSearchRepo.resetConsecutiveFailures(index.id);
    codeSearchRepo.updateIndexStatus(index.id, 'pending', null);

    // Restart indexing
    await this.startIndexing(directoryPath);
  }

  private handleWorkerMessage(indexId: string, result: WorkerResult): void {
    switch (result.type) {
      case 'progress':
        // Forward progress from worker (which now includes embedding phase)
        if (result.progress) {
          this.emit('indexing-progress', result.progress);
        }
        break;

      case 'file-parsed':
        // First file-parsed means initialization succeeded - clear the timeout
        this.clearWorkerTimeout(indexId);
        // File comes with embeddings already generated in worker
        // Just insert into DB (fast operation, won't block main thread)
        if (result.fileData) {
          this.insertFileData(indexId, result.fileData);
        }
        break;

      case 'complete':
        this.clearWorkerTimeout(indexId);
        if (!this.cancelledIndexes.has(indexId)) {
          this.handleIndexingComplete(indexId);
        }
        break;

      case 'error':
        this.clearWorkerTimeout(indexId);
        const errorIndex = codeSearchRepo.getIndexById(indexId);
        codeSearchRepo.updateIndexStatus(indexId, 'error', result.error ?? 'Unknown error');
        this.emit('indexing-error', { indexId, error: result.error, directoryPath: errorIndex?.directoryPath });
        break;
    }
  }

  /**
   * Insert file data (with pre-computed embeddings) into the database.
   * This is a fast operation since embeddings are already computed in the worker.
   */
  private insertFileData(indexId: string, fileData: NonNullable<WorkerResult['fileData']>): void {
    const { filePath, mtime, chunks, symbols } = fileData;

    // Check if index still exists (may have been deleted during re-index)
    const index = codeSearchRepo.getIndexById(indexId);
    if (!index) {
      console.log(`[CodeSearch] Skipping ${filePath} - index ${indexId} no longer exists`);
      return;
    }

    // Check if cancelled
    if (this.cancelledIndexes.has(indexId)) {
      return;
    }

    try {
      // Delete existing data for this file
      codeSearchRepo.deleteChunksByFile(indexId, filePath);
      codeSearchRepo.deleteSymbolsByFile(indexId, filePath);

      // Insert chunks (embeddings already computed by worker)
      for (const chunk of chunks) {
        codeSearchRepo.createChunk(
          indexId,
          filePath,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.chunkType as any,
          chunk.embedding
        );
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

    } catch (err) {
      console.error(`[CodeSearch] Error inserting file ${filePath}:`, err);
      this.emit('file-error', {
        indexId,
        filePath,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
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
    // BDHLNDR-40: a clean completion clears the crash-loop circuit breaker.
    codeSearchRepo.resetConsecutiveFailures(indexId);
    // BDHLNDR-46: record the embedding version this index was built with so a
    // future model/dtype change is detected and forces a clean re-index.
    codeSearchRepo.setEmbeddingVersion(indexId, EMBEDDING_VERSION);
    this.emit('indexing-complete', { indexId, directoryPath: index?.directoryPath });

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

    // Generate query embedding using query-specific method for better retrieval
    const provider = getEmbeddingProvider();
    const queryEmbedding = await provider.embedQuery(query);

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

  async deleteIndex(directoryPath: string): Promise<void> {
    const index = codeSearchRepo.getIndexByDirectory(directoryPath);
    if (index) {
      this.stopWatching(index.id);
      // Await termination before deleting the DB row so any in-flight
      // writes from the dying worker don't resurrect a deleted index.
      await this.cancelIndexing(index.id);
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

    for (const timeout of this.workerTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.workerTimeouts.clear();

    this.cancelledIndexes.clear();
    // Note: We don't dispose the embedding provider here because it may still be needed
    // for search queries. Each worker has its own instance that gets cleaned up when terminated.
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
