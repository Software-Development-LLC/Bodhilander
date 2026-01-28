console.log('[EmbeddingProvider] Loading @huggingface/transformers...');

// Import types for TypeScript, runtime value loaded dynamically
import type { FeatureExtractionPipeline as FeatureExtractionPipelineType } from '@huggingface/transformers';

let pipeline: typeof import('@huggingface/transformers').pipeline;

try {
  const transformers = require('@huggingface/transformers');
  pipeline = transformers.pipeline;
  console.log('[EmbeddingProvider] @huggingface/transformers loaded successfully');
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
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Initializing embedding model (attempt ${attempt}/${maxRetries})...`);
        // Cast to any to avoid complex union type issues with the transformers library
        this.pipeline = await (pipeline as any)('feature-extraction', this.name);
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

    const results: number[][] = [];

    for (const text of texts) {
      const embedding = await this.embedWithRetry(text);
      results.push(embedding);
    }

    return results;
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
    const truncatedText = text.slice(0, 8000);

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
