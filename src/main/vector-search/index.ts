import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { app } from 'electron';
import log from 'electron-log';
import * as codeSearchRepo from '../repositories/code-search';
import { EMBEDDING_VERSION } from './embedding-provider';
import { getEmbeddingService, disposeEmbeddingService } from './embedding-service';
import { resolveVectorSearchWorker } from './worker-path';
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

// BDHLNDR-126: an indexing worker requests embeddings from the main process,
// which brokers them to the single embedding worker and replies with an
// 'embed-response' (or 'embed-error') carrying the same requestId.
interface EmbedRequestMessage {
  type: 'embed-request';
  requestId: string;
  texts: string[];
}

// BDHLNDR-126: rolling inactivity watchdog for an indexing worker. Reset on
// every message from the worker; if it goes silent this long it is treated as
// hung and cancelled — otherwise a post-init hang (a bad file read, a
// pathological parse) would hold the global serialization gate forever and
// freeze ALL indexing. Generous enough to cover the initial model download and
// a single embed batch (itself bounded by the embedding worker's 5-min timeout).
const WORKER_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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

  // BDHLNDR-126: onnxruntime-node is driven from indexing worker threads, one
  // InferenceSession per index. Two workers running inference at once corrupt
  // the native allocator and SIGTRAP the whole process (confirmed crash: two
  // concurrent InferenceSession::Run stacks + byte-write translation faults).
  // Serialize globally: at most ONE indexing worker runs at a time; the rest
  // queue here and drain as workers end.
  private activeIndexId: string | null = null;
  private activeWorker: Worker | null = null; // the worker instance that holds the gate
  private indexQueue: string[] = []; // directoryPaths waiting for the gate
  private readonly queuedDirectories: Set<string> = new Set(); // dedupe indexQueue
  private readonly completedIndexes: Set<string> = new Set(); // clean terminate, not a crash

  constructor() {
    super();
  }

  /**
   * Get the path to the indexing worker script.
   * Worker threads cannot load from inside asar archives, so in packaged
   * builds we resolve to the app.asar.unpacked directory.
   */
  /**
   * BDHLNDR-46: if this index's stored vectors were generated with a different
   * embedding version (e.g. fp32 from <= v3.3.1, now embedding at q8), they are
   * not comparable to new query vectors. Wipe and rebuild from scratch rather
   * than mixing incompatible vectors. Must run before the crash circuit breaker:
   * clearIndexData resets status to 'pending', so a stale 'indexing' from an old
   * crash can't be miscounted as a fresh crash.
   */
  private reconcileEmbeddingVersion(index: CodeIndex, directoryPath: string): void {
    const persistedEmbeddingVersion = codeSearchRepo.getEmbeddingVersion(index.id);
    if (persistedEmbeddingVersion === EMBEDDING_VERSION) return;

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

  /**
   * Worker options for an indexing worker. In packaged apps the worker's
   * require() resolves from inside the asar by default, but native modules live
   * in app.asar.unpacked — so PREPEND that to NODE_PATH, preserving the existing
   * value so non-native modules still resolve from the archive.
   */
  private buildIndexingWorkerOptions(): Record<string, unknown> {
    // Capture worker stdout/stderr for debugging
    const workerOptions: Record<string, unknown> = { stdout: true, stderr: true };

    if (app.isPackaged) {
      const unpackedModules = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
      const asarModules = path.join(process.resourcesPath, 'app.asar', 'node_modules');
      const existingNodePath = process.env.NODE_PATH ?? '';
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const newNodePath = [unpackedModules, asarModules, existingNodePath]
        .filter(Boolean)
        .join(pathSep);
      workerOptions.env = { ...process.env, NODE_PATH: newNodePath };
    }

    return workerOptions;
  }

  private getWorkerPath(): string {
    return resolveVectorSearchWorker('indexing-worker.js');
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

    // BDHLNDR-126: global serialization gate. If another index is actively
    // indexing, queue this directory instead of spawning a second worker —
    // two concurrent onnxruntime InferenceSessions crash the process. The
    // queue is drained (startNextQueued) whenever the active worker ends.
    //
    // Same-index bypass invariant: `activeIndexId === index.id` here only
    // happens during a cancel + immediate restart of the SAME index —
    // cancelIndexing removes the worker from `workers` synchronously (so the
    // `workers.has` guard above passes) but the gate stays held until the
    // dying worker's 'exit' fires. The restart re-enters the gate it already
    // owns and installs a new worker/activeWorker; the superseded worker's
    // exit and error handlers are identity-guarded (ownsSlot/ownsGate below)
    // so the late exit can neither kill the new worker nor release the new
    // worker's gate. Changing any of these three pieces (sync workers.delete
    // in cancelIndexing, this bypass, the identity guards) requires
    // re-checking the other two.
    if (this.activeIndexId !== null && this.activeIndexId !== index.id) {
      if (!this.queuedDirectories.has(directoryPath)) {
        this.queuedDirectories.add(directoryPath);
        this.indexQueue.push(directoryPath);
        log.info(
          `[VectorSearch] Queued indexing for ${directoryPath} ` +
            `(worker busy with index ${this.activeIndexId})`
        );
      }
      return;
    }

    this.reconcileEmbeddingVersion(index, directoryPath);

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
        // BDHLNDR-126: we never took the gate; let any queued directory run.
        this.startNextQueued();
        return; // do NOT spawn the worker — breaks the crash-relaunch loop
      }
      log.warn(
        `[VectorSearch] Prior indexing attempt for ${directoryPath} did not ` +
          `complete (likely crashed); retry ${failures}/${MAX_CONSECUTIVE_INDEX_CRASHES}`
      );
    }

    // Clear the cancelled flag since we're starting fresh
    this.cancelledIndexes.delete(index.id);
    this.completedIndexes.delete(index.id);

    // BDHLNDR-126: take the global gate. Only this index may run inference
    // until its worker ends (releaseAndDrain in the exit handler frees it).
    this.activeIndexId = index.id;

    // Update status
    codeSearchRepo.updateIndexStatus(index.id, 'indexing');

    // Start worker - embeddings are now generated in the worker thread
    // In packaged apps, worker_threads cannot load from inside asar archives,
    // so we must use the unpacked path for both the script and module resolution
    const workerPath = this.getWorkerPath();
    const workerOptions = this.buildIndexingWorkerOptions();

    // BDHLNDR-126: the gate is already taken; if the worker fails to construct
    // synchronously there is no 'exit' handler yet to release it, and a
    // stranded gate would kill indexing for the rest of the session.
    let worker: Worker;
    try {
      worker = new Worker(workerPath, workerOptions);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error('[VectorSearch] Failed to spawn indexing worker:', errorMsg);
      codeSearchRepo.updateIndexStatus(index.id, 'error', errorMsg);
      this.emit('indexing-error', {
        indexId: index.id,
        error: errorMsg,
        directoryPath: index.directoryPath,
      });
      this.activeIndexId = null;
      this.activeWorker = null;
      this.startNextQueued();
      return;
    }

    this.workers.set(index.id, worker);
    this.activeWorker = worker;

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

    worker.on('message', (result: WorkerResult | EmbedRequestMessage) => {
      // Any message means the worker is alive — reset its inactivity watchdog.
      // Guard by identity so a superseded worker can't extend the current one's.
      if (this.workers.get(index.id) === worker) {
        this.armWorkerWatchdog(index);
      }
      // BDHLNDR-126: the indexing worker no longer runs onnxruntime itself; it
      // asks the single embedding worker (via this broker) to embed each batch.
      if ((result as EmbedRequestMessage).type === 'embed-request') {
        this.handleEmbedRequest(worker, result as EmbedRequestMessage);
        return;
      }
      this.handleWorkerMessage(index.id, result as WorkerResult);
    });

    worker.on('error', (err: Error) => {
      log.error('[VectorSearch] Worker error:', err);
      log.error('[VectorSearch] Worker error stack:', err.stack);
      // BDHLNDR-126: ignore an error from a worker that has already been
      // superseded for this index (cancel + same-index restart).
      if (this.workers.get(index.id) !== worker) return;
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
      // BDHLNDR-126: only the worker that still owns this index's slot / the
      // gate may mutate shared state. A superseded worker (cancel + same-index
      // restart during the terminate-await window) must not delete the new
      // worker, report a false error, or release the new worker's gate.
      const ownsSlot = this.workers.get(index.id) === worker;
      const ownsGate = this.activeWorker === worker;

      if (ownsSlot) {
        this.workers.delete(index.id);
        this.clearWorkerTimeout(index.id);
      }

      // A clean completion terminates the worker on purpose (non-zero code but
      // not a crash). A real crash was already reported by the 'error' handler
      // above, which deletes the slot — so ownsSlot is false here for crashes,
      // which also prevents double-reporting the same failure.
      if (
        ownsSlot &&
        code !== 0 &&
        !this.cancelledIndexes.has(index.id) &&
        !this.completedIndexes.has(index.id)
      ) {
        const errorMsg = `Worker exited with code ${code}`;
        log.error('[VectorSearch]', errorMsg);
        codeSearchRepo.updateIndexStatus(index.id, 'error', errorMsg);
        this.emit('indexing-error', {
          indexId: index.id,
          error: errorMsg,
          directoryPath: index.directoryPath,
        });
      }

      if (ownsSlot) {
        this.completedIndexes.delete(index.id);
      }

      // Release the global gate and start the next queued index.
      if (ownsGate) {
        this.activeIndexId = null;
        this.activeWorker = null;
        this.startNextQueued();
      }
    });

    // BDHLNDR-126: arm the rolling inactivity watchdog. It covers the initial
    // model download and any later hang, is reset on every worker message, and
    // is cleared on exit/complete/error.
    this.armWorkerWatchdog(index);

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

  // BDHLNDR-126: (re)arm the inactivity watchdog for an indexing worker. If the
  // worker sends no message within the window it is treated as hung and
  // cancelled — which terminates it, releasing the global gate and draining the
  // queue. Without this a post-init hang would freeze all indexing behind the gate.
  private armWorkerWatchdog(index: CodeIndex): void {
    this.clearWorkerTimeout(index.id);
    const timeout = setTimeout(() => {
      if (!this.workers.has(index.id)) return;
      const errorMsg = 'Indexing worker timed out (no progress)';
      log.error('[VectorSearch]', errorMsg);
      // cancelIndexing terminates the worker → its 'exit' releases the gate.
      this.cancelIndexing(index.id).catch((err) => {
        log.error('[VectorSearch] Error cancelling hung worker:', err);
      });
      codeSearchRepo.updateIndexStatus(index.id, 'error', errorMsg);
      this.emit('indexing-error', {
        indexId: index.id,
        error: errorMsg,
        directoryPath: index.directoryPath,
      });
    }, WORKER_INACTIVITY_TIMEOUT_MS);
    this.workerTimeouts.set(index.id, timeout);
  }

  // BDHLNDR-126: release the global indexing gate held by `indexId` (if it
  // holds it) and hand off to the next queued directory. Called from the
  // worker exit handler and the circuit-breaker early-return path.
  private releaseAndDrain(indexId: string): void {
    if (this.activeIndexId === indexId) {
      this.activeIndexId = null;
      this.activeWorker = null;
    }
    this.startNextQueued();
  }

  // BDHLNDR-126: remove a directory from the pending indexing queue so a
  // delete/cancel can't be resurrected when the gate later drains.
  private dequeueDirectory(directoryPath: string): void {
    if (this.queuedDirectories.delete(directoryPath)) {
      const i = this.indexQueue.indexOf(directoryPath);
      if (i !== -1) this.indexQueue.splice(i, 1);
    }
  }

  // BDHLNDR-126: if no worker is active, start indexing the next queued
  // directory. Fire-and-forget; startIndexing owns all error handling.
  private startNextQueued(): void {
    if (this.activeIndexId !== null) return;
    const next = this.indexQueue.shift();
    if (!next) return;
    this.queuedDirectories.delete(next);
    this.startIndexing(next).catch((err) => {
      log.error('[VectorSearch] Failed to start queued index:', err);
      // Don't strand the rest of the queue behind a failed dequeue.
      this.startNextQueued();
    });
  }

  async cancelIndexing(indexId: string): Promise<void> {
    // Mark as cancelled so worker knows to stop
    this.cancelledIndexes.add(indexId);
    this.clearWorkerTimeout(indexId);

    // BDHLNDR-126: if this index is only queued (not yet started), remove it
    // from the queue so the gate draining later doesn't auto-start it —
    // otherwise cancelling a queued index is silently undone.
    const queuedIndex = codeSearchRepo.getIndexById(indexId);
    if (queuedIndex) {
      this.dequeueDirectory(queuedIndex.directoryPath);
    }

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

  // BDHLNDR-126: forward an indexing worker's embed request to the single
  // embedding worker and reply on the same worker with the result. All
  // embedding in the process is serialized through the one embedding worker,
  // so no two InferenceSession::Run ever overlap.
  private handleEmbedRequest(worker: Worker, msg: EmbedRequestMessage): void {
    // The requesting worker may be terminated (cancel/dispose) before the
    // embedding resolves; posting to a dead worker is pointless and can throw
    // inside this .then, surfacing as an unhandledRejection.
    const stillRunning = (): boolean => {
      for (const w of this.workers.values()) {
        if (w === worker) return true;
      }
      return false;
    };
    const reply = (payload: Record<string, unknown>): void => {
      if (!stillRunning()) return;
      try {
        worker.postMessage(payload);
      } catch (err) {
        log.warn('[VectorSearch] Failed to deliver embedding to worker:', err);
      }
    };
    getEmbeddingService()
      .embed(msg.texts)
      .then(
        (embeddings) => reply({ type: 'embed-response', requestId: msg.requestId, embeddings }),
        (err: unknown) =>
          reply({
            type: 'embed-error',
            requestId: msg.requestId,
            error: err instanceof Error ? err.message : String(err),
          })
      );
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
        // BDHLNDR-126: liveness is now handled by the rolling inactivity
        // watchdog (reset on every message), so don't clear the timeout here —
        // that would disable the watchdog for the rest of the run.
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

    // BDHLNDR-126: tear the finished worker down instead of leaving it alive.
    // A lingering worker holds an idle onnxruntime InferenceSession and parked
    // native threads; these accumulate across directories and long uptimes and
    // feed the native-memory pressure behind the crash. Terminating fires
    // worker.on('exit'), which releases the global gate and drains the queue;
    // completedIndexes marks this as a clean exit so the exit handler doesn't
    // report the terminate as a crash.
    this.completedIndexes.add(indexId);
    const finishedWorker = this.workers.get(indexId);
    if (finishedWorker) {
      finishedWorker.terminate().catch((err) => {
        log.warn('[VectorSearch] Error terminating finished worker:', err);
      });
    } else {
      // No worker to terminate (shouldn't happen); free the gate directly.
      this.completedIndexes.delete(indexId);
      this.releaseAndDrain(indexId);
    }

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

    // Generate query embedding via the single embedding worker (BDHLNDR-126) —
    // never a main-process ONNX session, which could race an active index.
    let queryEmbedding: number[];
    try {
      queryEmbedding = await getEmbeddingService().embedQuery(query);
    } catch (err) {
      log.error('[VectorSearch] searchCode embedding failed:', err);
      // Rethrow rather than returning [] — an empty array here is
      // indistinguishable from "no matches" in the UI. The IPC handler
      // propagates the rejection to useCodeSearch (which renders
      // searchError) and the HTTP route maps it to a 500.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Semantic search is unavailable: ${msg}`);
    }
    if (queryEmbedding.length === 0) {
      return [];
    }
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
      // BDHLNDR-126: drop any queued entry so a later gate drain doesn't
      // recreate and re-index the directory we're about to delete.
      this.dequeueDirectory(directoryPath);
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
    // BDHLNDR-126: drop the serialization queue so worker exit handlers firing
    // after dispose (from the terminate() calls above) don't re-spawn workers.
    this.activeIndexId = null;
    this.activeWorker = null;
    this.indexQueue = [];
    this.queuedDirectories.clear();
    this.completedIndexes.clear();

    // BDHLNDR-126: tear down the single embedding worker (and its ONNX session)
    // on app teardown. It's spawned lazily and re-created on the next search or
    // index, so this is safe even if the manager is disposed while the app runs.
    disposeEmbeddingService();
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
