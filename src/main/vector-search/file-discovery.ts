import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

const DEFAULT_IGNORES = [
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'venv',
  '.venv',
  'env',
  '.env',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.cs',
  '.json',
  '.md',
]);

export interface DiscoveredFile {
  path: string;
  relativePath: string;
  mtime: number;
  size: number;
}

export interface FileDiscoveryOptions {
  maxFileSize?: number;
  maxFiles?: number;
  extensions?: Set<string>;
}

const DEFAULT_OPTIONS: FileDiscoveryOptions = {
  maxFileSize: 1024 * 1024, // 1MB
  maxFiles: 50000,
  extensions: SUPPORTED_EXTENSIONS,
};

export async function discoverFiles(
  rootDir: string,
  options: FileDiscoveryOptions = {}
): Promise<DiscoveredFile[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ig = createIgnoreFilter(rootDir);
  const files: DiscoveredFile[] = [];

  await walkDirectory(rootDir, rootDir, ig, files, opts);

  return files;
}

async function walkDirectory(
  currentDir: string,
  rootDir: string,
  ig: Ignore,
  files: DiscoveredFile[],
  options: FileDiscoveryOptions
): Promise<void> {
  if (files.length >= options.maxFiles!) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  } catch {
    return; // Skip directories we can't read
  }

  for (const entry of entries) {
    if (files.length >= options.maxFiles!) break;

    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    // Check ignore patterns
    if (ig.ignores(relativePath)) continue;

    if (entry.isDirectory()) {
      await walkDirectory(fullPath, rootDir, ig, files, options);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!options.extensions!.has(ext)) continue;

      try {
        const stats = await fs.promises.stat(fullPath);
        if (stats.size > options.maxFileSize!) continue;

        files.push({
          path: fullPath,
          relativePath,
          mtime: Math.floor(stats.mtimeMs),
          size: stats.size,
        });
      } catch {
        // Skip files we can't stat
      }
    }
  }
}

function createIgnoreFilter(rootDir: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORES);

  // Load .gitignore if exists
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      ig.add(content);
    } catch {
      // Ignore read errors
    }
  }

  // Load .claudeignore if exists
  const claudeignorePath = path.join(rootDir, '.claudeignore');
  if (fs.existsSync(claudeignorePath)) {
    try {
      const content = fs.readFileSync(claudeignorePath, 'utf-8');
      ig.add(content);
    } catch {
      // Ignore read errors
    }
  }

  return ig;
}

export function getLanguageFromExtension(ext: string): string | null {
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.pyw': 'python',
    '.cs': 'c_sharp',
    '.json': 'json',
    '.md': 'markdown',
  };
  return map[ext.toLowerCase()] ?? null;
}
