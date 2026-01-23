import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { discoverFiles, getLanguageFromExtension } from './file-discovery';
import { parseCode, ParsedSymbol } from './parser';

interface WorkerMessage {
  type: 'start' | 'cancel';
  indexId?: string;
  directoryPath?: string;
}

interface WorkerResult {
  type: 'progress' | 'file-parsed' | 'complete' | 'error';
  indexId: string;
  progress?: {
    indexId: string;
    directoryPath: string;
    status: 'indexing';
    filesTotal: number;
    filesIndexed: number;
    currentFile: string | null;
    error: null;
  };
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
    // Discover files
    sendProgress(indexId, directoryPath, 0, 0, 'Discovering files...');
    const files = await discoverFiles(directoryPath);

    if (cancelled) return;

    const totalFiles = files.length;
    let filesIndexed = 0;

    // Process each file - parse only, no embeddings (done in main thread)
    for (const file of files) {
      if (cancelled) return;

      sendProgress(indexId, directoryPath, totalFiles, filesIndexed, file.relativePath);

      try {
        const content = await fs.promises.readFile(file.path, 'utf-8');
        const ext = path.extname(file.path).toLowerCase();
        const language = getLanguageFromExtension(ext);

        const { chunks, symbols } = language
          ? parseCode(content, language)
          : { chunks: [], symbols: [] };

        // Send parsed file data back to main process (embeddings generated there)
        sendFileParsed(indexId, file.path, file.relativePath, file.mtime, chunks, symbols);

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
  currentFile: string | null
): void {
  const result: WorkerResult = {
    type: 'progress',
    indexId,
    progress: {
      indexId,
      directoryPath,
      status: 'indexing',
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
  chunks: Array<{
    content: string;
    startLine: number;
    endLine: number;
    chunkType: string | null;
  }>,
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
