// Log early to catch startup issues in packaged builds
console.log('[IndexingWorker] Starting worker thread...');
console.log('[IndexingWorker] NODE_PATH:', process.env.NODE_PATH);
console.log('[IndexingWorker] __dirname:', __dirname);

import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

// Import types for TypeScript (compile-time only)
import type { ParsedSymbol } from './parser';

// Wrap imports that depend on native modules in try/catch to log failures
let discoverFiles: typeof import('./file-discovery').discoverFiles;
let getLanguageFromExtension: typeof import('./file-discovery').getLanguageFromExtension;
let parseCode: typeof import('./parser').parseCode;

try {
  console.log('[IndexingWorker] Loading file-discovery module...');
  const fileDiscovery = require('./file-discovery');
  discoverFiles = fileDiscovery.discoverFiles;
  getLanguageFromExtension = fileDiscovery.getLanguageFromExtension;
  console.log('[IndexingWorker] file-discovery loaded successfully');
} catch (e) {
  console.error('[IndexingWorker] Failed to load file-discovery:', e);
  throw e;
}

try {
  console.log('[IndexingWorker] Loading parser module...');
  const parser = require('./parser');
  parseCode = parser.parseCode;
  console.log('[IndexingWorker] parser loaded successfully');
} catch (e) {
  console.error('[IndexingWorker] Failed to load parser:', e);
  throw e;
}

// BDHLNDR-126: this worker no longer loads onnxruntime/@huggingface/transformers.
// Embeddings are produced by the single shared embedding worker so only one
// InferenceSession exists in the whole process.

interface WorkerMessage {
  type: 'start' | 'cancel';
  indexId?: string;
  directoryPath?: string;
  cacheDir?: string;
}

interface ChunkWithEmbedding {
  content: string;
  startLine: number;
  endLine: number;
  chunkType: string | null;
  embedding: number[] | null;
}

interface WorkerResult {
  type: 'progress' | 'file-parsed' | 'complete' | 'error';
  indexId: string;
  progress?: {
    indexId: string;
    directoryPath: string;
    status: 'indexing';
    phase: 'parsing' | 'embedding';
    filesTotal: number;
    filesIndexed: number;
    currentFile: string | null;
    error: null;
  };
  fileData?: {
    filePath: string;
    relativePath: string;
    mtime: number;
    chunks: ChunkWithEmbedding[];
    symbols: ParsedSymbol[];
  };
  error?: string;
}

// BDHLNDR-126: embeddings come from the single embedding worker via the main
// process. This worker parses files and asks main to embed each batch
// (embed-request → embed-response/embed-error), correlated by requestId, so
// only one onnxruntime InferenceSession exists across the whole process.
interface PendingEmbed {
  resolve: (embeddings: number[][]) => void;
  reject: (err: Error) => void;
}
const pendingEmbeds = new Map<string, PendingEmbed>();
let embedSeq = 0;

function requestEmbeddings(texts: string[]): Promise<number[][]> {
  const requestId = `${++embedSeq}`;
  return new Promise<number[][]>((resolve, reject) => {
    pendingEmbeds.set(requestId, { resolve, reject });
    parentPort?.postMessage({ type: 'embed-request', requestId, texts });
  });
}

parentPort?.on(
  'message',
  (message: { type?: string; requestId?: string; embeddings?: number[][]; error?: string }) => {
    if (message?.type === 'embed-response' && message.requestId) {
      const p = pendingEmbeds.get(message.requestId);
      if (p) {
        pendingEmbeds.delete(message.requestId);
        p.resolve(message.embeddings ?? []);
      }
    } else if (message?.type === 'embed-error' && message.requestId) {
      const p = pendingEmbeds.get(message.requestId);
      if (p) {
        pendingEmbeds.delete(message.requestId);
        p.reject(new Error(message.error || 'Embedding failed'));
      }
    }
  }
);

let cancelled = false;

// Track current indexId for global error handlers
let currentIndexId: string | null = null;

// Global error handlers to catch native module crashes and unhandled rejections
process.on('uncaughtException', (err) => {
  console.error('[IndexingWorker] Uncaught exception:', err);
  if (currentIndexId) {
    sendError(currentIndexId, `Uncaught exception: ${err.message}`);
  }
  // Give the message time to send before the process terminates
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[IndexingWorker] Unhandled rejection:', msg);
  if (currentIndexId) {
    sendError(currentIndexId, `Unhandled rejection: ${msg}`);
  }
});

parentPort?.on('message', async (message: WorkerMessage) => {
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (message.type === 'start') {
    cancelled = false;
    currentIndexId = message.indexId!;

    // Configure HuggingFace cache directory if provided
    if (message.cacheDir) {
      try {
        // Set environment variable for @huggingface/transformers cache
        process.env.HF_HOME = message.cacheDir;
        process.env.TRANSFORMERS_CACHE = path.join(message.cacheDir, 'models');
      } catch (e) {
        console.warn('[IndexingWorker] Failed to set cache dir:', e);
      }
    }

    await runIndexing(message.indexId!, message.directoryPath!);
    currentIndexId = null;
  }
});

async function runIndexing(
  indexId: string,
  directoryPath: string
): Promise<void> {
  try {
    // Discover files. Embeddings are generated by the single embedding worker
    // (BDHLNDR-126); this worker only parses and requests embeddings over RPC.
    sendProgress(indexId, directoryPath, 0, 0, 'parsing', 'Discovering files...');
    const files = await discoverFiles(directoryPath);
    console.log(`[IndexingWorker] Discovered ${files.length} files in ${directoryPath}`);

    if (cancelled) return;

    const totalFiles = files.length;
    let filesIndexed = 0;
    // BDHLNDR-126: track embedding success so a run where EVERY batch failed
    // (e.g. the embedding worker is persistently down) is reported as an error
    // instead of being silently marked 'ready' with all-null vectors.
    let embedAttempted = 0;
    let embedSucceeded = 0;

    // Process each file - parse AND generate embeddings in worker
    for (const file of files) {
      if (cancelled) return;

      sendProgress(indexId, directoryPath, totalFiles, filesIndexed, 'embedding', file.relativePath);

      try {
        const content = await fs.promises.readFile(file.path, 'utf-8');
        const ext = path.extname(file.path).toLowerCase();
        const language = getLanguageFromExtension(ext);

        const { chunks, symbols } = language
          ? parseCode(content, language)
          : { chunks: [], symbols: [] };

        // Generate embeddings in batches for better throughput.
        // BDHLNDR-40: peak ONNX tensor ≈ BATCH_SIZE × longest-seq-in-batch.
        // 32 was a key contributor to the arena-exhaustion crash; 16 halves
        // peak memory. Per-text embeddings are independent of batch size
        // (no cross-sequence attention), so this is numerically identical —
        // no re-index needed.
        const BATCH_SIZE = 16;
        const chunksWithEmbeddings: ChunkWithEmbedding[] = [];
        if (chunks.length > 0) {
          const textsToEmbed = chunks.map(chunk => {
            const contextPrefix = `File: ${file.relativePath} | Type: ${chunk.chunkType || 'code'} | Code:
`;
            return contextPrefix + chunk.content;
          });

          for (let i = 0; i < textsToEmbed.length; i += BATCH_SIZE) {
            if (cancelled) return;
            const batch = textsToEmbed.slice(i, i + BATCH_SIZE);
            embedAttempted += batch.length;
            try {
              const embeddings = await requestEmbeddings(batch);
              for (let j = 0; j < batch.length; j++) {
                const embedding = embeddings[j] ?? null;
                if (embedding) embedSucceeded++;
                chunksWithEmbeddings.push({
                  ...chunks[i + j],
                  embedding,
                });
              }
            } catch (embErr) {
              console.warn(`[IndexingWorker] Batch embedding failed for ${file.path}:`, embErr);
              for (let j = 0; j < batch.length; j++) {
                chunksWithEmbeddings.push({
                  ...chunks[i + j],
                  embedding: null,
                });
              }
            }
          }
        }
        // Send complete file data (with embeddings) to main process
        sendFileParsed(indexId, file.path, file.relativePath, file.mtime, chunksWithEmbeddings, symbols);

      } catch (err) {
        // Log error but continue with other files
        console.error(`[IndexingWorker] Error processing file ${file.path}:`, err);
      }

      filesIndexed++;

      // Yield so the worker can service cancel messages and let progress IPC
      // flush. Without this, long runs silently pin the worker thread for
      // minutes and the user has no way to stop them.
      await new Promise(resolve => setImmediate(resolve));
    }

    // BDHLNDR-126: if there was content to embed but not a single embedding
    // succeeded, the embedding pipeline is down — don't mark the index 'ready'
    // (which would look complete yet return nothing and suppress a re-index).
    if (embedAttempted > 0 && embedSucceeded === 0) {
      sendError(indexId, 'Embedding failed for all content (embedding service unavailable)');
      return;
    }

    sendComplete(indexId);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[IndexingWorker] Indexing failed:', errorMsg);
    sendError(indexId, errorMsg);
  }
}

function sendProgress(
  indexId: string,
  directoryPath: string,
  filesTotal: number,
  filesIndexed: number,
  phase: 'parsing' | 'embedding',
  currentFile: string | null
): void {
  const result: WorkerResult = {
    type: 'progress',
    indexId,
    progress: {
      indexId,
      directoryPath,
      status: 'indexing',
      phase,
      filesTotal,
      filesIndexed,
      currentFile,
      error: null,
    },
  };
  parentPort?.postMessage(result);
}

function sendFileParsed(
  indexId: string,
  filePath: string,
  relativePath: string,
  mtime: number,
  chunks: ChunkWithEmbedding[],
  symbols: ParsedSymbol[]
): void {
  const result: WorkerResult = {
    type: 'file-parsed',
    indexId,
    fileData: { filePath, relativePath, mtime, chunks, symbols },
  };
  parentPort?.postMessage(result);
}

function sendComplete(indexId: string): void {
  const result: WorkerResult = { type: 'complete', indexId };
  parentPort?.postMessage(result);
}

function sendError(indexId: string, error: string): void {
  const result: WorkerResult = { type: 'error', indexId, error };
  parentPort?.postMessage(result);
}
