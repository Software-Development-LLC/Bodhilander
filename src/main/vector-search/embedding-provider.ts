console.log('[EmbeddingProvider] Loading @huggingface/transformers...');

import os from 'os';

// Import types for TypeScript, runtime value loaded dynamically
import type { FeatureExtractionPipeline as FeatureExtractionPipelineType } from '@huggingface/transformers';

let pipeline: typeof import('@huggingface/transformers').pipeline;

// Cap ONNX threads so indexing doesn't saturate every CPU core.
// Default onnxruntime behavior is intraOpNumThreads = physical cores, which
// pins the machine during long indexing runs. Half the cores, max 4, min 1.
const EMBEDDING_THREAD_COUNT = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));

// BDHLNDR-46: bumped whenever a change alters embedding numerics so stored
// vectors become incomparable to freshly-generated ones. Persisted per index
// (code_indexes.embedding_version); a mismatch forces a clean re-index.
//   1 = fp32 (original, shipped through v3.3.1)
//   2 = q8 quantized + token-bounded truncation
export const EMBEDDING_VERSION = 2;

// bge-base-en-v1.5 only attends to its first 512 tokens; the tokenizer
// truncates to that anyway. Bounding input chars keeps tokenization and the
// peak ONNX tensor predictable (BDHLNDR-46/40). ~4 chars/token for code, so
// 2048 chars reliably yields ≥512 tokens — the model sees the same content
// it did under the old 8000-char cap, just without the wasted work.
const MAX_EMBED_CHARS = 2048;

try {
  const transformers = require('@huggingface/transformers');
  pipeline = transformers.pipeline;
  // WASM numThreads matters when transformers falls back to the WASM backend;
  // harmless when onnxruntime-node is in use.
  if (transformers.env?.backends?.onnx?.wasm) {
    transformers.env.backends.onnx.wasm.numThreads = EMBEDDING_THREAD_COUNT;
  }
  console.log(
    `[EmbeddingProvider] @huggingface/transformers loaded successfully (thread cap=${EMBEDDING_THREAD_COUNT})`
  );
} catch (e) {
  console.error('[EmbeddingProvider] Failed to load @huggingface/transformers:', e);
  throw e;
}

// Alias for use in class
type FeatureExtractionPipeline = FeatureExtractionPipelineType;

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
  dispose(): void;
}

// BGE models require a specific instruction prefix for queries
const BGE_QUERY_PREFIX = 'Represent this code search query: ';

export class HuggingFaceEmbeddingProvider implements EmbeddingProvider {
  name: string;
  dimensions: number;
  private pipeline: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<void> | null = null;
  private isBgeModel: boolean;

  // Using bge-base-en-v1.5 for much better retrieval quality
  // ~110MB model, 768 dimensions, top performer on MTEB benchmark
  constructor(modelName: string = 'Xenova/bge-base-en-v1.5', dimensions: number = 768) {
    this.name = modelName;
    this.dimensions = dimensions;
    this.isBgeModel = modelName.includes('bge-');
  }

  async initialize(): Promise<void> {
    if (this.pipeline) return;

    // Prevent multiple simultaneous initializations
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } catch (err) {
      // BDHLNDR-126: a failed init must not poison the provider. Since all
      // embedding now shares ONE long-lived provider in ONE worker, leaving a
      // rejected initPromise would make every future embed/search re-throw the
      // stale error process-wide until app restart. Null it so a later call
      // retries doInitialize (which has its own bounded retries).
      this.initPromise = null;
      throw err;
    }
  }

  private async doInitialize(): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Initializing embedding model (attempt ${attempt}/${maxRetries})...`);
        // Cast to any to avoid complex union type issues with the transformers library.
        // session_options caps onnxruntime-node thread usage so indexing doesn't
        // pin every core.
        this.pipeline = await (pipeline as any)('feature-extraction', this.name, {
          // BDHLNDR-46: quantized (int8) model — ~4× smaller weights and
          // activation tensors than the fp32 default, the main headroom fix
          // for the ONNX arena-exhaustion crash. Changes embedding numerics
          // (see EMBEDDING_VERSION) so a re-index is forced on upgrade.
          dtype: 'q8',
          session_options: {
            intraOpNumThreads: EMBEDDING_THREAD_COUNT,
            interOpNumThreads: 1,
            // BDHLNDR-40: ONNX Runtime's BFC arena grows to the worst-case
            // batch and never shrinks; a later larger batch forces
            // BFCArena::Extend, which traps (SIGTRAP) on allocation failure
            // and kills the whole process. Disabling the CPU arena makes ORT
            // allocate per-request instead of holding a growing pool —
            // numerically identical output, just bounded memory. This is the
            // exact counter to the confirmed crash frame.
            enableCpuMemArena: false,
          },
        });
        console.log('Embedding model initialized successfully');
        return;
      } catch (error) {
        lastError = error as Error;
        console.error(`Failed to initialize embedding model (attempt ${attempt}/${maxRetries}):`, error);

        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s...
          const delay = 1000 * Math.pow(2, attempt - 1);
          console.log(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Failed to initialize embedding model after retries');
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.pipeline) {
      await this.initialize();
    }

    if (texts.length === 0) return [];

    // Truncate to model max token budget before handing to the pipeline.
    const truncated = texts.map(t => t.slice(0, MAX_EMBED_CHARS));

    // Real batched inference: feed the whole array once so ONNX can amortize
    // the forward pass. Previously this looped one text at a time, which meant
    // BATCH_SIZE=32 in the indexing worker was really 32 sequential calls.
    try {
      const output = await this.pipeline!(truncated, {
        pooling: 'mean',
        normalize: true,
      });

      const data = output.data as Float32Array;
      const dims = this.dimensions;
      const results: number[][] = new Array(truncated.length);
      for (let i = 0; i < truncated.length; i++) {
        results[i] = Array.from(data.slice(i * dims, (i + 1) * dims));
      }
      return results;
    } catch (batchErr) {
      // On batch failure, fall back to per-text with retries so a single bad
      // input can't take out the whole batch.
      console.warn('[EmbeddingProvider] Batched embed failed, falling back to per-text:', batchErr);
      const results: number[][] = [];
      for (const text of texts) {
        results.push(await this.embedWithRetry(text));
      }
      return results;
    }
  }

  /**
   * Embed a search query with special handling for BGE models.
   * BGE models perform better when queries have a specific prefix.
   */
  async embedQuery(query: string): Promise<number[]> {
    if (!this.pipeline) {
      await this.initialize();
    }

    // BGE models require a query instruction prefix for optimal retrieval
    const textToEmbed = this.isBgeModel ? `${BGE_QUERY_PREFIX}${query}` : query;
    return this.embedWithRetry(textToEmbed);
  }

  private async embedWithRetry(text: string, maxRetries: number = 3): Promise<number[]> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.embedSingle(text);
      } catch (error) {
        lastError = error as Error;
        console.warn(`Embedding attempt ${attempt}/${maxRetries} failed:`, error);

        if (attempt < maxRetries) {
          // Exponential backoff: 100ms, 200ms, 400ms...
          const delay = 100 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Embedding failed after retries');
  }

  private async embedSingle(text: string): Promise<number[]> {
    if (!this.pipeline) throw new Error('Pipeline not initialized');

    // Truncate text if too long (model has max token limit)
    const truncatedText = text.slice(0, MAX_EMBED_CHARS);

    const output = await this.pipeline(truncatedText, {
      pooling: 'mean',
      normalize: true,
    });

    // Extract the embedding array from the tensor
    const embedding = Array.from(output.data as Float32Array);

    return embedding;
  }

  dispose(): void {
    this.pipeline = null;
    this.initPromise = null;
  }
}

// Factory function with singleton pattern
let provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!provider) {
    provider = new HuggingFaceEmbeddingProvider();
  }
  return provider;
}

export function disposeEmbeddingProvider(): void {
  if (provider) {
    provider.dispose();
    provider = null;
  }
}
