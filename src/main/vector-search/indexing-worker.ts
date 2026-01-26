import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { discoverFiles, getLanguageFromExtension } from './file-discovery';
import { parseCode, ParsedSymbol } from './parser';
import { HuggingFaceEmbeddingProvider } from './embedding-provider';

interface WorkerMessage {
  type: 'start' | 'cancel';
  indexId?: string;
  directoryPath?: string;
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

// Embedding provider instance for this worker
let embeddingProvider: HuggingFaceEmbeddingProvider | null = null;

let cancelled = false;

parentPort?.on('message', async (message: WorkerMessage) => {
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (message.type === 'start') {
    cancelled = false;
    await runIndexing(message.indexId!, message.directoryPath!);
  }
});

async function runIndexing(
  indexId: string,
  directoryPath: string
): Promise<void> {
  try {
    // Initialize embedding provider if not already done
    if (!embeddingProvider) {
      sendProgress(indexId, directoryPath, 0, 0, 'parsing', 'Loading embedding model...');
      embeddingProvider = new HuggingFaceEmbeddingProvider();
      await embeddingProvider.initialize();
    }

    // Discover files
    sendProgress(indexId, directoryPath, 0, 0, 'parsing', 'Discovering files...');
    const files = await discoverFiles(directoryPath);

    if (cancelled) return;

    const totalFiles = files.length;
    let filesIndexed = 0;

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

        // Generate embeddings for each chunk (this is the CPU-intensive part)
        const chunksWithEmbeddings: ChunkWithEmbedding[] = [];
        for (const chunk of chunks) {
          if (cancelled) return;

          try {
            // Add context to chunk for better embedding quality
            const contextPrefix = `File: ${file.relativePath} | Type: ${chunk.chunkType || 'code'} | Code:\n`;
            const textToEmbed = contextPrefix + chunk.content;

            const [embedding] = await embeddingProvider!.embed([textToEmbed]);
            chunksWithEmbeddings.push({
              ...chunk,
              embedding,
            });
          } catch (embErr) {
            // If embedding fails, still include chunk without embedding
            console.warn(`Embedding failed for chunk in ${file.path}:`, embErr);
            chunksWithEmbeddings.push({
              ...chunk,
              embedding: null,
            });
          }
        }

        // Send complete file data (with embeddings) to main process
        sendFileParsed(indexId, file.path, file.relativePath, file.mtime, chunksWithEmbeddings, symbols);

      } catch (err) {
        // Log error but continue with other files
        console.error(`Error processing file ${file.path}:`, err);
      }

      filesIndexed++;
    }

    sendComplete(indexId);

  } catch (err) {
    sendError(indexId, err instanceof Error ? err.message : String(err));
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
