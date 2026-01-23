import { pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  dispose(): void;
}

export class HuggingFaceEmbeddingProvider implements EmbeddingProvider {
  name: string;
  dimensions: number;
  private pipeline: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(modelName: string = 'Xenova/all-MiniLM-L6-v2', dimensions: number = 384) {
    this.name = modelName;
    this.dimensions = dimensions;
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
    try {
      this.pipeline = await pipeline('feature-extraction', this.name, {
        // Use quantized model for faster inference
        quantized: true,
      });
    } catch (error) {
      console.error('Failed to initialize embedding model:', error);
      throw error;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.pipeline) {
      await this.initialize();
    }

    const results: number[][] = [];

    for (const text of texts) {
      const embedding = await this.embedSingle(text);
      results.push(embedding);
    }

    return results;
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
