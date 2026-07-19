import { Worker } from 'worker_threads';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import { resolveVectorSearchWorker } from './worker-path';

interface PendingRequest {
  resolve: (embeddings: number[][]) => void;
  reject: (err: Error) => void;
}

/**
 * BDHLNDR-126: main-process broker in front of the single embedding worker.
 *
 * Every embedding in the app — indexing chunk batches (via the indexing
 * worker's RPC) and search queries (via searchCode) — goes through this one
 * service, which owns the only long-lived onnxruntime InferenceSession in the
 * process. The worker processes requests serially, so at most one
 * InferenceSession::Run is ever in flight. This eliminates the concurrent-
 * inference native memory corruption that SIGTRAP-crashed the app when two
 * sessions (two indexing workers, or an index + a search) ran at once.
 */
export class EmbeddingService {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private seq = 0;

  // A stalled native inference emits no 'error'/'exit', so bound every request.
  // Generous enough to cover a cold model download on the first call (matches
  // the indexing init timeout); only a genuine hang trips it.
  private static readonly REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const workerPath = resolveVectorSearchWorker('embedding-worker.js');
    const workerOptions: any = { stdout: true, stderr: true };

    if (app.isPackaged) {
      // Native modules (onnxruntime-node) live in app.asar.unpacked; prepend
      // that to NODE_PATH so the worker's require() finds them, then the asar
      // node_modules for regular deps. Mirrors the indexing worker.
      const unpackedModules = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
      const asarModules = path.join(process.resourcesPath, 'app.asar', 'node_modules');
      const existingNodePath = process.env.NODE_PATH || '';
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const newNodePath = [unpackedModules, asarModules, existingNodePath].filter(Boolean).join(pathSep);
      workerOptions.env = { ...process.env, NODE_PATH: newNodePath };
    }

    let worker: Worker;
    try {
      worker = new Worker(workerPath, workerOptions);
    } catch (err) {
      // Symmetry with the indexing-worker spawn guard: surface a clear error
      // (callers — searchCode / handleEmbedRequest — degrade gracefully).
      const msg = err instanceof Error ? err.message : String(err);
      log.error('[EmbeddingService] Failed to spawn embedding worker:', msg);
      throw new Error(`Embedding worker failed to start: ${msg}`);
    }

    if (worker.stdout) {
      worker.stdout.on('data', (d: Buffer) => log.info('[EmbeddingWorker]', d.toString().trim()));
    }
    if (worker.stderr) {
      worker.stderr.on('data', (d: Buffer) => log.error('[EmbeddingWorker]', d.toString().trim()));
    }

    worker.on('message', (msg: any) => {
      if (msg?.type === 'embed-result') {
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          p.resolve(msg.embeddings as number[][]);
        }
      } else if (msg?.type === 'embed-error') {
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          p.reject(new Error(msg.error || 'Embedding failed'));
        }
      }
    });

    const failAll = (err: Error) => {
      // Only the current worker's terminal event may fail requests. 'error' and
      // 'exit' both fire for a dying worker, and by the time the late one
      // arrives a replacement worker may already own `this.worker`/`pending` —
      // failing those would orphan a live worker and can leave two running.
      if (this.worker !== worker) return;
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      // Drop the reference so the next request respawns a fresh worker.
      this.worker = null;
    };

    worker.on('error', (err) => {
      log.error('[EmbeddingService] Worker error:', err);
      failAll(err instanceof Error ? err : new Error(String(err)));
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        log.error(`[EmbeddingService] Worker exited with code ${code}`);
      }
      failAll(new Error(`Embedding worker exited (code ${code})`));
    });

    // Configure the HuggingFace model cache directory up front.
    const cacheDir = path.join(app.getPath('userData'), 'huggingface');
    worker.postMessage({ type: 'init', cacheDir });

    this.worker = worker;
    return worker;
  }

  /** Embed passage texts (indexing). Returns one vector per input text. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.request(texts, false);
  }

  /** Embed a single search query (the provider adds the BGE query prefix). */
  async embedQuery(query: string): Promise<number[]> {
    const [embedding] = await this.request([query], true);
    return embedding ?? [];
  }

  private request(texts: string[], isQuery: boolean): Promise<number[][]> {
    const worker = this.ensureWorker();
    const requestId = `${++this.seq}`;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return; // already settled
        log.error(
          `[EmbeddingService] Embed request ${requestId} exceeded ` +
            `${EmbeddingService.REQUEST_TIMEOUT_MS}ms; restarting embedding worker`
        );
        // A hung worker won't recover on its own. Terminating fires 'exit' →
        // failAll, which rejects every pending request for this worker and
        // clears this.worker so the next request respawns a fresh one.
        void worker.terminate();
      }, EmbeddingService.REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: (embeddings) => {
          clearTimeout(timer);
          resolve(embeddings);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      worker.postMessage({ type: 'embed', requestId, texts, isQuery });
    });
  }

  dispose(): void {
    for (const [, p] of this.pending) {
      p.reject(new Error('Embedding service disposed'));
    }
    this.pending.clear();
    if (this.worker) {
      void this.worker.terminate();
      this.worker = null;
    }
  }
}

// Singleton — one embedding worker for the whole process.
let service: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (!service) {
    service = new EmbeddingService();
  }
  return service;
}

export function disposeEmbeddingService(): void {
  if (service) {
    service.dispose();
    service = null;
  }
}
