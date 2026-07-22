// BDHLNDR-126: the ONE and only onnxruntime InferenceSession in the process.
//
// Two InferenceSessions running inference at the same time corrupt the native
// allocator and SIGTRAP the whole app. Previously every indexing worker owned
// its own session AND the main process owned another for search queries, so any
// overlap (two directories indexing, or a search firing during an index) could
// crash. This worker is the single inference authority: indexing workers and
// the search path both funnel their embed requests here, and every request is
// processed strictly one-at-a-time through a serial promise chain — so only one
// InferenceSession::Run is ever in flight across the entire process.
console.log('[EmbeddingWorker] Starting worker thread...');
console.log('[EmbeddingWorker] NODE_PATH:', process.env.NODE_PATH);
console.log('[EmbeddingWorker] __dirname:', __dirname);

import { parentPort } from 'worker_threads';

import type { HuggingFaceEmbeddingProvider as HuggingFaceEmbeddingProviderType } from './embedding-provider';

// Native-dependent module loaded via require so a load failure is logged with
// context (mirrors indexing-worker.ts, which is proven in production).
let HuggingFaceEmbeddingProviderClass: typeof import('./embedding-provider').HuggingFaceEmbeddingProvider;
let setModelCacheDir: typeof import('./embedding-provider').setModelCacheDir;

try {
  console.log('[EmbeddingWorker] Loading embedding-provider module...');
  const embeddingModule = require('./embedding-provider');
  HuggingFaceEmbeddingProviderClass = embeddingModule.HuggingFaceEmbeddingProvider;
  setModelCacheDir = embeddingModule.setModelCacheDir;
  console.log('[EmbeddingWorker] embedding-provider loaded successfully');
} catch (e) {
  console.error('[EmbeddingWorker] Failed to load embedding-provider:', e);
  throw e;
}

interface InitMessage {
  type: 'init';
  cacheDir?: string;
}

interface EmbedMessage {
  type: 'embed';
  requestId: string;
  texts: string[];
  isQuery: boolean;
}

type IncomingMessage = InitMessage | EmbedMessage;

let provider: HuggingFaceEmbeddingProviderType | null = null;

// Serial execution chain: every embed request is appended here so at most one
// provider call (one InferenceSession::Run) executes at a time. `.catch` keeps
// a failed request from breaking the chain for the ones behind it.
let chain: Promise<void> = Promise.resolve();

// Global handlers so a native crash / rejection is logged before the process
// dies, matching the indexing worker's behavior.
process.on('uncaughtException', (err) => {
  console.error('[EmbeddingWorker] Uncaught exception:', err);
  setTimeout(() => process.exit(1), 100);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[EmbeddingWorker] Unhandled rejection:', msg);
});

function getProvider(): HuggingFaceEmbeddingProviderType {
  provider ??= new HuggingFaceEmbeddingProviderClass();
  return provider;
}

parentPort?.on('message', (message: IncomingMessage) => {
  if (message.type === 'init') {
    if (message.cacheDir) {
      try {
        // transformers.js caches to env.cacheDir (NOT HF_HOME /
        // TRANSFORMERS_CACHE — those are Python-only and are ignored, which
        // let the model download into the signed .app bundle, issue #133).
        // Runs before the first embed → before the pipeline loads.
        setModelCacheDir(message.cacheDir);
      } catch (e) {
        console.warn('[EmbeddingWorker] Failed to set cache dir:', e);
      }
    }
    return;
  }

  if (message.type === 'embed') {
    const { requestId, texts, isQuery } = message;
    // Append to the serial chain. Do NOT let one request's failure reject the
    // chain for later requests.
    chain = chain.then(async () => {
      try {
        const p = getProvider();
        const embeddings: number[][] = isQuery
          ? [await p.embedQuery(texts[0] ?? '')]
          : await p.embed(texts);
        parentPort?.postMessage({ type: 'embed-result', requestId, embeddings });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[EmbeddingWorker] Embed request ${requestId} failed:`, errMsg);
        parentPort?.postMessage({ type: 'embed-error', requestId, error: errMsg });
      }
    });
  }
});
