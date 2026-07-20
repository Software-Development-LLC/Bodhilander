import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

/**
 * Resolve a built worker script under dist/main/vector-search for both dev and
 * packaged builds. Worker threads cannot load from inside an asar archive, so
 * packaged builds resolve to app.asar.unpacked (electron-builder unpacks
 * dist/main/vector-search/** — see electron-builder.yml).
 */
export function resolveVectorSearchWorker(fileName: string): string {
  if (!app.isPackaged) {
    return path.join(__dirname, fileName);
  }

  const unpackedPath = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'dist',
    'main',
    'vector-search',
    fileName
  );

  if (fs.existsSync(unpackedPath)) {
    return unpackedPath;
  }

  // Fallback to __dirname (will likely fail in asar, but the log shows the issue)
  console.warn('[VectorSearch] Unpacked worker not found at:', unpackedPath);
  return path.join(__dirname, fileName);
}
