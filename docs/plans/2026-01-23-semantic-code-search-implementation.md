# Semantic Code Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add semantic code search and symbol lookup to ClaudeLander, enabling Claude and users to search codebases by meaning.

**Architecture:** Worker-based indexing pipeline using tree-sitter for parsing, ONNX for embeddings, and sqlite-vec for vector storage. MCP tools expose search to Claude. React modal provides direct user access.

**Tech Stack:** tree-sitter, onnxruntime-node, sqlite-vec, chokidar, React

**Design Document:** `docs/plans/2026-01-23-semantic-code-search-design.md`

---

## Phase 1: Foundation

### Task 1.1: Add Native Dependencies

**Files:**
- Modify: `D:\Projects\claudelander\package.json`
- Modify: `D:\Projects\claudelander\electron-builder.yml`

**Step 1: Install dependencies**

Run:
```bash
npm install onnxruntime-node tree-sitter tree-sitter-typescript tree-sitter-javascript tree-sitter-python tree-sitter-c-sharp chokidar ignore
```

**Step 2: Add sqlite-vec (SQLite extension)**

Run:
```bash
npm install sqlite-vec
```

**Step 3: Update electron-rebuild in package.json**

Edit `package.json` postinstall script:
```json
"postinstall": "electron-rebuild -o better-sqlite3,sodium-native,node-pty,onnxruntime-node,tree-sitter && node node_modules/node-pty/scripts/post-install.js"
```

**Step 4: Update asarUnpack in electron-builder.yml**

Add to asarUnpack array:
```yaml
asarUnpack:
  - dist/mcp-server/**/*
  - dist/hooks/**/*
  - node_modules/node-pty/**/*
  - node_modules/better-sqlite3/**/*
  - node_modules/sodium-native/**/*
  - node_modules/onnxruntime-node/**/*
  - node_modules/tree-sitter/**/*
  - node_modules/tree-sitter-*/**/*
  - node_modules/sqlite-vec/**/*
  - resources/models/**/*
```

**Step 5: Run postinstall to rebuild**

Run:
```bash
npm run postinstall
```
Expected: Native modules rebuild successfully

**Step 6: Commit**

```bash
git add package.json package-lock.json electron-builder.yml
git commit -m "chore: add semantic search native dependencies"
```

---

### Task 1.2: Add Shared Types

**Files:**
- Modify: `D:\Projects\claudelander\src\shared\types.ts`

**Step 1: Add code search types**

Add to end of `src/shared/types.ts`:
```typescript
// Code Search Types
export type ChunkType = 'function' | 'class' | 'method' | 'interface' | 'type' | 'block';
export type SymbolType = 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type';
export type IndexStatus = 'pending' | 'indexing' | 'ready' | 'error';

export interface CodeIndex {
  id: string;
  directoryPath: string;
  lastIndexedAt: Date | null;
  status: IndexStatus;
  fileCount: number;
  chunkCount: number;
  modelName: string;
  embeddingDimensions: number;
  errorMessage: string | null;
}

export interface IndexedFile {
  id: string;
  indexId: string;
  filePath: string;
  mtime: number;
  fileHash: string | null;
  chunkCount: number;
}

export interface CodeChunk {
  id: string;
  indexId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  chunkType: ChunkType | null;
  embedding: number[] | null;
  createdAt: Date;
}

export interface CodeSymbol {
  id: string;
  indexId: string;
  name: string;
  symbolType: SymbolType;
  filePath: string;
  line: number;
  column: number;
  parentSymbolId: string | null;
  signature: string | null;
  createdAt: Date;
}

export interface CodeSearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  chunkType: ChunkType | null;
}

export interface SymbolSearchResult {
  name: string;
  symbolType: SymbolType;
  filePath: string;
  line: number;
  column: number;
  signature: string | null;
}

export interface IndexProgress {
  indexId: string;
  directoryPath: string;
  status: IndexStatus;
  filesTotal: number;
  filesIndexed: number;
  currentFile: string | null;
  error: string | null;
}
```

**Step 2: Verify TypeScript compiles**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add code search types"
```

---

### Task 1.3: Create Database Schema Migration

**Files:**
- Modify: `D:\Projects\claudelander\src\main\database.ts`

**Step 1: Read current database.ts structure**

Read the file to understand the migration pattern.

**Step 2: Add sqlite-vec extension loading**

Add near the top after database initialization:
```typescript
import * as sqliteVec from 'sqlite-vec';

// After: const database = new Database(dbPath);
// Add:
sqliteVec.load(database);
```

**Step 3: Add code search tables**

Add new function after existing table creation:
```typescript
function initializeCodeSearchTables(db: Database.Database): void {
  // Code indexes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_indexes (
      id TEXT PRIMARY KEY,
      directory_path TEXT UNIQUE NOT NULL,
      last_indexed_at TEXT,
      status TEXT CHECK(status IN ('pending', 'indexing', 'ready', 'error')) DEFAULT 'pending',
      file_count INTEGER DEFAULT 0,
      chunk_count INTEGER DEFAULT 0,
      model_name TEXT DEFAULT 'default',
      embedding_dimensions INTEGER DEFAULT 768,
      error_message TEXT
    )
  `);

  // Indexed files table
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_files (
      id TEXT PRIMARY KEY,
      index_id TEXT NOT NULL REFERENCES code_indexes(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      file_hash TEXT,
      chunk_count INTEGER DEFAULT 0,
      UNIQUE(index_id, file_path)
    )
  `);

  // Code chunks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id TEXT PRIMARY KEY,
      index_id TEXT NOT NULL REFERENCES code_indexes(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      chunk_type TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Symbols table
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      index_id TEXT NOT NULL REFERENCES code_indexes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      symbol_type TEXT CHECK(symbol_type IN ('function', 'class', 'method', 'variable', 'interface', 'type')),
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      column INTEGER NOT NULL,
      parent_symbol_id TEXT REFERENCES symbols(id),
      signature TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Indexes for fast lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_index_id ON code_chunks(index_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON code_chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_index_file ON code_chunks(index_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_index_id ON symbols(index_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_files_index_id ON indexed_files(index_id);
    CREATE INDEX IF NOT EXISTS idx_files_mtime ON indexed_files(mtime);
  `);

  // Vector table for similarity search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_vec USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding FLOAT[768]
    )
  `);

  // Triggers to keep vec table in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_insert_vec AFTER INSERT ON code_chunks
    WHEN NEW.embedding IS NOT NULL BEGIN
      INSERT INTO code_chunks_vec(chunk_id, embedding)
      VALUES (NEW.id, NEW.embedding);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_delete_vec AFTER DELETE ON code_chunks BEGIN
      DELETE FROM code_chunks_vec WHERE chunk_id = OLD.id;
    END
  `);
}
```

**Step 4: Call initialization in initializeDatabase function**

Add call to `initializeCodeSearchTables(db)` in the `initializeDatabase` function.

**Step 5: Verify database initializes**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 6: Commit**

```bash
git add src/main/database.ts
git commit -m "feat: add code search database schema with sqlite-vec"
```

---

### Task 1.4: Create Code Search Repository

**Files:**
- Create: `D:\Projects\claudelander\src\main\repositories\code-search.ts`

**Step 1: Create repository file**

```typescript
import { v4 as uuid } from 'uuid';
import { getDatabase } from '../database';
import type {
  CodeIndex,
  IndexedFile,
  CodeChunk,
  CodeSymbol,
  CodeSearchResult,
  SymbolSearchResult,
  IndexStatus,
  ChunkType,
  SymbolType,
} from '../../shared/types';

// ============ Code Indexes ============

export function getIndexByDirectory(directoryPath: string): CodeIndex | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM code_indexes WHERE directory_path = ?')
    .get(directoryPath) as any;

  if (!row) return null;
  return mapRowToCodeIndex(row);
}

export function getIndexById(id: string): CodeIndex | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM code_indexes WHERE id = ?')
    .get(id) as any;

  if (!row) return null;
  return mapRowToCodeIndex(row);
}

export function createIndex(directoryPath: string, modelName: string = 'default', dimensions: number = 768): CodeIndex {
  const db = getDatabase();
  const id = uuid();

  db.prepare(`
    INSERT INTO code_indexes (id, directory_path, status, model_name, embedding_dimensions)
    VALUES (?, ?, 'pending', ?, ?)
  `).run(id, directoryPath, modelName, dimensions);

  return getIndexById(id)!;
}

export function updateIndexStatus(
  id: string,
  status: IndexStatus,
  errorMessage?: string | null
): void {
  const db = getDatabase();
  const updates: string[] = ['status = ?'];
  const params: any[] = [status];

  if (status === 'ready') {
    updates.push('last_indexed_at = ?');
    params.push(new Date().toISOString());
  }

  if (errorMessage !== undefined) {
    updates.push('error_message = ?');
    params.push(errorMessage);
  }

  params.push(id);
  db.prepare(`UPDATE code_indexes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

export function updateIndexCounts(id: string, fileCount: number, chunkCount: number): void {
  const db = getDatabase();
  db.prepare('UPDATE code_indexes SET file_count = ?, chunk_count = ? WHERE id = ?')
    .run(fileCount, chunkCount, id);
}

export function deleteIndex(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM code_indexes WHERE id = ?').run(id);
}

// ============ Indexed Files ============

export function getIndexedFile(indexId: string, filePath: string): IndexedFile | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM indexed_files WHERE index_id = ? AND file_path = ?')
    .get(indexId, filePath) as any;

  if (!row) return null;
  return mapRowToIndexedFile(row);
}

export function getIndexedFiles(indexId: string): IndexedFile[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM indexed_files WHERE index_id = ?')
    .all(indexId) as any[];

  return rows.map(mapRowToIndexedFile);
}

export function upsertIndexedFile(
  indexId: string,
  filePath: string,
  mtime: number,
  fileHash?: string | null
): IndexedFile {
  const db = getDatabase();
  const existing = getIndexedFile(indexId, filePath);

  if (existing) {
    db.prepare(`
      UPDATE indexed_files SET mtime = ?, file_hash = ? WHERE id = ?
    `).run(mtime, fileHash ?? null, existing.id);
    return { ...existing, mtime, fileHash: fileHash ?? null };
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO indexed_files (id, index_id, file_path, mtime, file_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, indexId, filePath, mtime, fileHash ?? null);

  return { id, indexId, filePath, mtime, fileHash: fileHash ?? null, chunkCount: 0 };
}

export function deleteIndexedFile(indexId: string, filePath: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM indexed_files WHERE index_id = ? AND file_path = ?')
    .run(indexId, filePath);
}

export function updateFileChunkCount(indexId: string, filePath: string, count: number): void {
  const db = getDatabase();
  db.prepare('UPDATE indexed_files SET chunk_count = ? WHERE index_id = ? AND file_path = ?')
    .run(count, indexId, filePath);
}

// ============ Code Chunks ============

export function createChunk(
  indexId: string,
  filePath: string,
  startLine: number,
  endLine: number,
  content: string,
  chunkType?: ChunkType | null,
  embedding?: number[] | null
): CodeChunk {
  const db = getDatabase();
  const id = uuid();
  const embeddingBlob = embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;

  db.prepare(`
    INSERT INTO code_chunks (id, index_id, file_path, start_line, end_line, content, chunk_type, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, indexId, filePath, startLine, endLine, content, chunkType ?? null, embeddingBlob);

  return {
    id,
    indexId,
    filePath,
    startLine,
    endLine,
    content,
    chunkType: chunkType ?? null,
    embedding: embedding ?? null,
    createdAt: new Date(),
  };
}

export function deleteChunksByFile(indexId: string, filePath: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM code_chunks WHERE index_id = ? AND file_path = ?')
    .run(indexId, filePath);
}

export function searchChunksByVector(
  indexId: string,
  queryEmbedding: number[],
  limit: number = 10
): CodeSearchResult[] {
  const db = getDatabase();
  const embeddingBlob = Buffer.from(new Float32Array(queryEmbedding).buffer);

  const rows = db.prepare(`
    SELECT
      c.file_path,
      c.start_line,
      c.end_line,
      c.content,
      c.chunk_type,
      v.distance
    FROM code_chunks_vec v
    JOIN code_chunks c ON c.id = v.chunk_id
    WHERE c.index_id = ?
    ORDER BY v.distance
    LIMIT ?
  `).all(indexId, limit) as any[];

  return rows.map(row => ({
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    chunkType: row.chunk_type,
    score: 1 - row.distance, // Convert distance to similarity
  }));
}

// ============ Symbols ============

export function createSymbol(
  indexId: string,
  name: string,
  symbolType: SymbolType,
  filePath: string,
  line: number,
  column: number,
  signature?: string | null,
  parentSymbolId?: string | null
): CodeSymbol {
  const db = getDatabase();
  const id = uuid();

  db.prepare(`
    INSERT INTO symbols (id, index_id, name, symbol_type, file_path, line, column, signature, parent_symbol_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, indexId, name, symbolType, filePath, line, column, signature ?? null, parentSymbolId ?? null);

  return {
    id,
    indexId,
    name,
    symbolType,
    filePath,
    line,
    column,
    signature: signature ?? null,
    parentSymbolId: parentSymbolId ?? null,
    createdAt: new Date(),
  };
}

export function deleteSymbolsByFile(indexId: string, filePath: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM symbols WHERE index_id = ? AND file_path = ?')
    .run(indexId, filePath);
}

export function searchSymbols(
  indexId: string,
  name: string,
  symbolType?: SymbolType,
  limit: number = 20
): SymbolSearchResult[] {
  const db = getDatabase();

  let query = `
    SELECT name, symbol_type, file_path, line, column, signature
    FROM symbols
    WHERE index_id = ? AND name LIKE ?
  `;
  const params: any[] = [indexId, `%${name}%`];

  if (symbolType) {
    query += ' AND symbol_type = ?';
    params.push(symbolType);
  }

  query += ' ORDER BY name LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params) as any[];

  return rows.map(row => ({
    name: row.name,
    symbolType: row.symbol_type,
    filePath: row.file_path,
    line: row.line,
    column: row.column,
    signature: row.signature,
  }));
}

// ============ Mappers ============

function mapRowToCodeIndex(row: any): CodeIndex {
  return {
    id: row.id,
    directoryPath: row.directory_path,
    lastIndexedAt: row.last_indexed_at ? new Date(row.last_indexed_at) : null,
    status: row.status,
    fileCount: row.file_count,
    chunkCount: row.chunk_count,
    modelName: row.model_name,
    embeddingDimensions: row.embedding_dimensions,
    errorMessage: row.error_message,
  };
}

function mapRowToIndexedFile(row: any): IndexedFile {
  return {
    id: row.id,
    indexId: row.index_id,
    filePath: row.file_path,
    mtime: row.mtime,
    fileHash: row.file_hash,
    chunkCount: row.chunk_count,
  };
}
```

**Step 2: Verify build**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/main/repositories/code-search.ts
git commit -m "feat: add code search repository with CRUD operations"
```

---

## Phase 2: Indexing Core

### Task 2.1: Create File Discovery Module

**Files:**
- Create: `D:\Projects\claudelander\src\main\vector-search\file-discovery.ts`

**Step 1: Create vector-search directory and file**

```typescript
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
```

**Step 2: Verify build**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/main/vector-search/file-discovery.ts
git commit -m "feat: add file discovery with gitignore support"
```

---

### Task 2.2: Create Tree-Sitter Parser Module

**Files:**
- Create: `D:\Projects\claudelander\src\main\vector-search\parser.ts`

**Step 1: Create parser module**

```typescript
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import CSharp from 'tree-sitter-c-sharp';
import type { ChunkType, SymbolType } from '../../shared/types';

export interface ParsedChunk {
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
}

export interface ParsedSymbol {
  name: string;
  symbolType: SymbolType;
  line: number;
  column: number;
  signature: string | null;
  parentName: string | null;
}

export interface ParseResult {
  chunks: ParsedChunk[];
  symbols: ParsedSymbol[];
}

const parsers: Map<string, Parser> = new Map();

function getParser(language: string): Parser | null {
  if (parsers.has(language)) {
    return parsers.get(language)!;
  }

  const parser = new Parser();
  let lang: any;

  switch (language) {
    case 'typescript':
      lang = TypeScript.typescript;
      break;
    case 'tsx':
      lang = TypeScript.tsx;
      break;
    case 'javascript':
      lang = JavaScript;
      break;
    case 'python':
      lang = Python;
      break;
    case 'c_sharp':
      lang = CSharp;
      break;
    default:
      return null;
  }

  parser.setLanguage(lang);
  parsers.set(language, parser);
  return parser;
}

export function parseCode(content: string, language: string): ParseResult {
  const parser = getParser(language);

  if (!parser) {
    return fallbackParse(content);
  }

  const tree = parser.parse(content);
  const chunks: ParsedChunk[] = [];
  const symbols: ParsedSymbol[] = [];

  extractNodes(tree.rootNode, content, chunks, symbols, language);

  // If no chunks found, use fallback
  if (chunks.length === 0) {
    return fallbackParse(content);
  }

  return { chunks, symbols };
}

function extractNodes(
  node: Parser.SyntaxNode,
  content: string,
  chunks: ParsedChunk[],
  symbols: ParsedSymbol[],
  language: string,
  parentName: string | null = null
): void {
  const nodeTypes = getRelevantNodeTypes(language);

  if (nodeTypes.functions.includes(node.type)) {
    const name = getNodeName(node, language);
    const signature = getSignature(node, content);

    if (name) {
      symbols.push({
        name,
        symbolType: 'function',
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        signature,
        parentName,
      });
    }

    chunks.push({
      content: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkType: 'function',
    });
    return; // Don't recurse into functions
  }

  if (nodeTypes.classes.includes(node.type)) {
    const name = getNodeName(node, language);

    if (name) {
      symbols.push({
        name,
        symbolType: 'class',
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        signature: null,
        parentName,
      });

      // Recurse with class name as parent
      for (const child of node.children) {
        extractNodes(child, content, chunks, symbols, language, name);
      }
    }

    chunks.push({
      content: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkType: 'class',
    });
    return;
  }

  if (nodeTypes.methods.includes(node.type)) {
    const name = getNodeName(node, language);
    const signature = getSignature(node, content);

    if (name) {
      symbols.push({
        name,
        symbolType: 'method',
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        signature,
        parentName,
      });
    }

    chunks.push({
      content: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkType: 'method',
    });
    return;
  }

  if (nodeTypes.interfaces.includes(node.type)) {
    const name = getNodeName(node, language);

    if (name) {
      symbols.push({
        name,
        symbolType: 'interface',
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        signature: null,
        parentName,
      });
    }

    chunks.push({
      content: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      chunkType: 'interface',
    });
    return;
  }

  // Recurse into children
  for (const child of node.children) {
    extractNodes(child, content, chunks, symbols, language, parentName);
  }
}

function getRelevantNodeTypes(language: string): {
  functions: string[];
  classes: string[];
  methods: string[];
  interfaces: string[];
} {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      return {
        functions: ['function_declaration', 'arrow_function', 'function_expression'],
        classes: ['class_declaration'],
        methods: ['method_definition'],
        interfaces: ['interface_declaration', 'type_alias_declaration'],
      };
    case 'python':
      return {
        functions: ['function_definition'],
        classes: ['class_definition'],
        methods: ['function_definition'], // Methods are also function_definition in Python
        interfaces: [],
      };
    case 'c_sharp':
      return {
        functions: ['method_declaration', 'local_function_statement'],
        classes: ['class_declaration', 'struct_declaration'],
        methods: ['method_declaration'],
        interfaces: ['interface_declaration'],
      };
    default:
      return { functions: [], classes: [], methods: [], interfaces: [] };
  }
}

function getNodeName(node: Parser.SyntaxNode, language: string): string | null {
  // Try common name field patterns
  const nameNode = node.childForFieldName('name') ??
                   node.children.find(c => c.type === 'identifier' || c.type === 'property_identifier');

  return nameNode?.text ?? null;
}

function getSignature(node: Parser.SyntaxNode, content: string): string | null {
  // Get first line as signature (simplified)
  const firstLineEnd = node.text.indexOf('\n');
  if (firstLineEnd === -1) return node.text;
  return node.text.substring(0, firstLineEnd).trim();
}

function fallbackParse(content: string): ParseResult {
  const lines = content.split('\n');
  const chunks: ParsedChunk[] = [];
  const CHUNK_SIZE = 50;

  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const chunkLines = lines.slice(i, i + CHUNK_SIZE);
    chunks.push({
      content: chunkLines.join('\n'),
      startLine: i + 1,
      endLine: Math.min(i + CHUNK_SIZE, lines.length),
      chunkType: 'block',
    });
  }

  return { chunks, symbols: [] };
}
```

**Step 2: Verify build**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/main/vector-search/parser.ts
git commit -m "feat: add tree-sitter parser for code chunking and symbol extraction"
```

---

### Task 2.3: Create Embedding Provider

**Files:**
- Create: `D:\Projects\claudelander\src\main\vector-search\embedding-provider.ts`

**Step 1: Create embedding provider interface and ONNX implementation**

```typescript
import * as ort from 'onnxruntime-node';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  dispose(): void;
}

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  name: string;
  dimensions: number;
  private session: ort.InferenceSession | null = null;
  private modelPath: string;
  private tokenizerPath: string;
  private tokenizer: any = null;

  constructor(modelName: string = 'all-mpnet-base-v2', dimensions: number = 768) {
    this.name = modelName;
    this.dimensions = dimensions;

    // Model stored in resources/models/
    const resourcesPath = app.isPackaged
      ? path.join(process.resourcesPath, 'models')
      : path.join(app.getAppPath(), 'resources', 'models');

    this.modelPath = path.join(resourcesPath, modelName, 'model.onnx');
    this.tokenizerPath = path.join(resourcesPath, modelName, 'tokenizer.json');
  }

  async initialize(): Promise<void> {
    if (this.session) return;

    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Model not found: ${this.modelPath}`);
    }

    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
    });

    // Load tokenizer (simplified - in production, use proper tokenizer library)
    if (fs.existsSync(this.tokenizerPath)) {
      const tokenizerJson = JSON.parse(fs.readFileSync(this.tokenizerPath, 'utf-8'));
      this.tokenizer = tokenizerJson;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.session) {
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
    if (!this.session) throw new Error('Session not initialized');

    // Simplified tokenization - in production, use proper tokenizer
    const tokens = this.tokenize(text);

    const inputIds = new BigInt64Array(tokens.map(t => BigInt(t)));
    const attentionMask = new BigInt64Array(tokens.map(() => BigInt(1)));

    const feeds = {
      input_ids: new ort.Tensor('int64', inputIds, [1, tokens.length]),
      attention_mask: new ort.Tensor('int64', attentionMask, [1, tokens.length]),
    };

    const results = await this.session.run(feeds);

    // Get pooled output (sentence embedding)
    const output = results['sentence_embedding'] ?? results['last_hidden_state'];
    const embedding = Array.from(output.data as Float32Array).slice(0, this.dimensions);

    // Normalize
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return embedding.map(val => val / norm);
  }

  private tokenize(text: string): number[] {
    // Simplified tokenization - just split on whitespace and map to indices
    // In production, use @xenova/transformers or proper tokenizer
    const words = text.toLowerCase().split(/\s+/).slice(0, 512);
    const vocab = this.tokenizer?.model?.vocab ?? {};

    const tokens = [101]; // [CLS]
    for (const word of words) {
      const id = vocab[word] ?? vocab['[UNK]'] ?? 100;
      tokens.push(id);
    }
    tokens.push(102); // [SEP]

    return tokens;
  }

  dispose(): void {
    this.session = null;
  }
}

// Factory function
let provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!provider) {
    provider = new OnnxEmbeddingProvider();
  }
  return provider;
}

export function disposeEmbeddingProvider(): void {
  if (provider) {
    provider.dispose();
    provider = null;
  }
}
```

**Step 2: Create models directory placeholder**

```bash
mkdir -p resources/models
echo "Place ONNX embedding models here" > resources/models/README.md
```

**Step 3: Verify build**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/main/vector-search/embedding-provider.ts resources/models/README.md
git commit -m "feat: add ONNX embedding provider"
```

---

## Phase 3: Indexing Worker

### Task 3.1: Create Indexing Worker

**Files:**
- Create: `D:\Projects\claudelander\src\main\vector-search\indexing-worker.ts`

**Step 1: Create worker entry point**

```typescript
import { parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';
import { discoverFiles, getLanguageFromExtension } from './file-discovery';
import { parseCode } from './parser';
import { OnnxEmbeddingProvider } from './embedding-provider';
import type { IndexProgress, ParsedChunk, ParsedSymbol } from '../../shared/types';

interface WorkerMessage {
  type: 'start' | 'cancel';
  indexId?: string;
  directoryPath?: string;
  modelName?: string;
}

interface WorkerResult {
  type: 'progress' | 'file-complete' | 'complete' | 'error';
  indexId: string;
  progress?: IndexProgress;
  fileData?: {
    filePath: string;
    mtime: number;
    chunks: Array<{
      content: string;
      startLine: number;
      endLine: number;
      chunkType: string | null;
      embedding: number[];
    }>;
    symbols: ParsedSymbol[];
  };
  error?: string;
}

let cancelled = false;
let embeddingProvider: OnnxEmbeddingProvider | null = null;

parentPort?.on('message', async (message: WorkerMessage) => {
  if (message.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (message.type === 'start') {
    cancelled = false;
    await runIndexing(message.indexId!, message.directoryPath!, message.modelName);
  }
});

async function runIndexing(
  indexId: string,
  directoryPath: string,
  modelName?: string
): Promise<void> {
  try {
    // Initialize embedding provider
    embeddingProvider = new OnnxEmbeddingProvider(modelName);
    await embeddingProvider.initialize();

    // Discover files
    sendProgress(indexId, directoryPath, 'indexing', 0, 0, 'Discovering files...');
    const files = await discoverFiles(directoryPath);

    if (cancelled) return;

    const totalFiles = files.length;
    let filesIndexed = 0;

    // Process each file
    for (const file of files) {
      if (cancelled) return;

      sendProgress(indexId, directoryPath, 'indexing', totalFiles, filesIndexed, file.relativePath);

      try {
        const content = await fs.promises.readFile(file.path, 'utf-8');
        const ext = file.path.substring(file.path.lastIndexOf('.'));
        const language = getLanguageFromExtension(ext);

        const { chunks, symbols } = language
          ? parseCode(content, language)
          : { chunks: [], symbols: [] };

        // Generate embeddings for chunks
        const embeddedChunks: Array<{
          content: string;
          startLine: number;
          endLine: number;
          chunkType: string | null;
          embedding: number[];
        }> = [];

        // Batch embedding generation
        const BATCH_SIZE = 32;
        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
          if (cancelled) return;

          const batch = chunks.slice(i, i + BATCH_SIZE);
          const texts = batch.map(c => c.content);
          const embeddings = await embeddingProvider.embed(texts);

          for (let j = 0; j < batch.length; j++) {
            embeddedChunks.push({
              content: batch[j].content,
              startLine: batch[j].startLine,
              endLine: batch[j].endLine,
              chunkType: batch[j].chunkType,
              embedding: embeddings[j],
            });
          }
        }

        // Send file results back to main process
        sendFileComplete(indexId, file.path, file.mtime, embeddedChunks, symbols);

      } catch (err) {
        // Log error but continue with other files
        console.error(`Error processing file ${file.path}:`, err);
      }

      filesIndexed++;
    }

    sendComplete(indexId);

  } catch (err) {
    sendError(indexId, err instanceof Error ? err.message : String(err));
  } finally {
    embeddingProvider?.dispose();
    embeddingProvider = null;
  }
}

function sendProgress(
  indexId: string,
  directoryPath: string,
  status: 'indexing',
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
      status,
      filesTotal,
      filesIndexed,
      currentFile,
      error: null,
    },
  };
  parentPort?.postMessage(result);
}

function sendFileComplete(
  indexId: string,
  filePath: string,
  mtime: number,
  chunks: Array<{
    content: string;
    startLine: number;
    endLine: number;
    chunkType: string | null;
    embedding: number[];
  }>,
  symbols: ParsedSymbol[]
): void {
  const result: WorkerResult = {
    type: 'file-complete',
    indexId,
    fileData: { filePath, mtime, chunks, symbols },
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
```

**Step 2: Verify build**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/main/vector-search/indexing-worker.ts
git commit -m "feat: add indexing worker for background processing"
```

---

### Task 3.2: Create Vector Search Manager

**Files:**
- Create: `D:\Projects\claudelander\src\main\vector-search\index.ts`

**Step 1: Create main manager module**

```typescript
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { EventEmitter } from 'events';
import * as codeSearchRepo from '../repositories/code-search';
import { getEmbeddingProvider } from './embedding-provider';
import type { CodeIndex, IndexProgress, CodeSearchResult, SymbolSearchResult, SymbolType } from '../../shared/types';

export class VectorSearchManager extends EventEmitter {
  private workers: Map<string, Worker> = new Map();
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    super();
  }

  // ============ Index Management ============

  async getOrCreateIndex(directoryPath: string): Promise<CodeIndex> {
    let index = codeSearchRepo.getIndexByDirectory(directoryPath);

    if (!index) {
      index = codeSearchRepo.createIndex(directoryPath);
    }

    return index;
  }

  async startIndexing(directoryPath: string): Promise<void> {
    const index = await this.getOrCreateIndex(directoryPath);

    // Cancel any existing indexing for this directory
    this.cancelIndexing(index.id);

    // Update status
    codeSearchRepo.updateIndexStatus(index.id, 'indexing');

    // Start worker
    const workerPath = path.join(__dirname, 'indexing-worker.js');
    const worker = new Worker(workerPath);

    this.workers.set(index.id, worker);

    worker.on('message', (result: any) => {
      this.handleWorkerMessage(index.id, result);
    });

    worker.on('error', (err) => {
      console.error('Worker error:', err);
      codeSearchRepo.updateIndexStatus(index.id, 'error', err.message);
      this.workers.delete(index.id);
    });

    worker.on('exit', (code) => {
      this.workers.delete(index.id);
      if (code !== 0) {
        codeSearchRepo.updateIndexStatus(index.id, 'error', `Worker exited with code ${code}`);
      }
    });

    worker.postMessage({
      type: 'start',
      indexId: index.id,
      directoryPath,
      modelName: index.modelName,
    });
  }

  cancelIndexing(indexId: string): void {
    const worker = this.workers.get(indexId);
    if (worker) {
      worker.postMessage({ type: 'cancel' });
      worker.terminate();
      this.workers.delete(indexId);
    }
  }

  private handleWorkerMessage(indexId: string, result: any): void {
    switch (result.type) {
      case 'progress':
        this.emit('indexing-progress', result.progress);
        break;

      case 'file-complete':
        this.handleFileComplete(indexId, result.fileData);
        break;

      case 'complete':
        this.handleIndexingComplete(indexId);
        break;

      case 'error':
        codeSearchRepo.updateIndexStatus(indexId, 'error', result.error);
        this.emit('indexing-error', { indexId, error: result.error });
        break;
    }
  }

  private handleFileComplete(indexId: string, fileData: any): void {
    const { filePath, mtime, chunks, symbols } = fileData;

    // Delete existing data for this file
    codeSearchRepo.deleteChunksByFile(indexId, filePath);
    codeSearchRepo.deleteSymbolsByFile(indexId, filePath);

    // Insert new chunks
    for (const chunk of chunks) {
      codeSearchRepo.createChunk(
        indexId,
        filePath,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        chunk.chunkType,
        chunk.embedding
      );
    }

    // Insert new symbols
    const symbolIdMap = new Map<string, string>();
    for (const symbol of symbols) {
      const parentId = symbol.parentName ? symbolIdMap.get(symbol.parentName) : null;
      const created = codeSearchRepo.createSymbol(
        indexId,
        symbol.name,
        symbol.symbolType,
        filePath,
        symbol.line,
        symbol.column,
        symbol.signature,
        parentId
      );
      symbolIdMap.set(symbol.name, created.id);
    }

    // Update file record
    codeSearchRepo.upsertIndexedFile(indexId, filePath, mtime);
    codeSearchRepo.updateFileChunkCount(indexId, filePath, chunks.length);
  }

  private handleIndexingComplete(indexId: string): void {
    // Update counts
    const index = codeSearchRepo.getIndexById(indexId);
    if (index) {
      const files = codeSearchRepo.getIndexedFiles(indexId);
      const chunkCount = files.reduce((sum, f) => sum + f.chunkCount, 0);
      codeSearchRepo.updateIndexCounts(indexId, files.length, chunkCount);
    }

    codeSearchRepo.updateIndexStatus(indexId, 'ready');
    this.emit('indexing-complete', { indexId });

    // Start file watcher
    if (index) {
      this.startWatching(index.directoryPath, indexId);
    }
  }

  // ============ File Watching ============

  startWatching(directoryPath: string, indexId: string): void {
    if (this.watchers.has(indexId)) return;

    const watcher = chokidar.watch(directoryPath, {
      ignored: /(^|[\/\\])\.|node_modules|dist|build/,
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on('change', (filePath) => {
      this.handleFileChange(indexId, filePath);
    });

    watcher.on('add', (filePath) => {
      this.handleFileChange(indexId, filePath);
    });

    watcher.on('unlink', (filePath) => {
      this.handleFileDelete(indexId, filePath);
    });

    this.watchers.set(indexId, watcher);
  }

  stopWatching(indexId: string): void {
    const watcher = this.watchers.get(indexId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(indexId);
    }
  }

  private handleFileChange(indexId: string, filePath: string): void {
    // Debounce changes
    const key = `${indexId}:${filePath}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      this.reindexFile(indexId, filePath);
    }, 500));
  }

  private handleFileDelete(indexId: string, filePath: string): void {
    codeSearchRepo.deleteChunksByFile(indexId, filePath);
    codeSearchRepo.deleteSymbolsByFile(indexId, filePath);
    codeSearchRepo.deleteIndexedFile(indexId, filePath);
  }

  private async reindexFile(indexId: string, filePath: string): Promise<void> {
    // Re-index single file inline (no worker needed for single file)
    // This would need the parsing and embedding logic
    // For now, just emit an event - full implementation would be more complex
    this.emit('file-changed', { indexId, filePath });
  }

  // ============ Search ============

  async searchCode(
    directoryPath: string,
    query: string,
    limit: number = 10
  ): Promise<CodeSearchResult[]> {
    const index = codeSearchRepo.getIndexByDirectory(directoryPath);
    if (!index || index.status !== 'ready') {
      return [];
    }

    // Generate query embedding
    const provider = getEmbeddingProvider();
    const [queryEmbedding] = await provider.embed([query]);

    return codeSearchRepo.searchChunksByVector(index.id, queryEmbedding, limit);
  }

  searchSymbols(
    directoryPath: string,
    name: string,
    symbolType?: SymbolType,
    limit: number = 20
  ): SymbolSearchResult[] {
    const index = codeSearchRepo.getIndexByDirectory(directoryPath);
    if (!index || index.status !== 'ready') {
      return [];
    }

    return codeSearchRepo.searchSymbols(index.id, name, symbolType, limit);
  }

  getIndexStatus(directoryPath: string): CodeIndex | null {
    return codeSearchRepo.getIndexByDirectory(directoryPath);
  }

  // ============ Cleanup ============

  dispose(): void {
    for (const [id, worker] of this.workers) {
      worker.terminate();
    }
    this.workers.clear();

    for (const [id, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}

// Singleton instance
let manager: VectorSearchManager | null = null;

export function getVectorSearchManager(): VectorSearchManager {
  if (!manager) {
    manager = new VectorSearchManager();
  }
  return manager;
}

export function disposeVectorSearchManager(): void {
  if (manager) {
    manager.dispose();
    manager = null;
  }
}
```

**Step 2: Verify build**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/main/vector-search/index.ts
git commit -m "feat: add VectorSearchManager with indexing and search"
```

---

## Phase 4: Integration

### Task 4.1: Add IPC Handlers

**Files:**
- Modify: `D:\Projects\claudelander\src\main\index.ts`

**Step 1: Import vector search manager**

Add imports at top:
```typescript
import { getVectorSearchManager, disposeVectorSearchManager } from './vector-search';
```

**Step 2: Add IPC handlers in the ipcMain section**

Add with other IPC handlers:
```typescript
// Vector Search IPC Handlers
ipcMain.handle('vector-search:get-index-status', (_, directoryPath: string) => {
  return getVectorSearchManager().getIndexStatus(directoryPath);
});

ipcMain.handle('vector-search:start-indexing', async (_, directoryPath: string) => {
  await getVectorSearchManager().startIndexing(directoryPath);
  return { success: true };
});

ipcMain.handle('vector-search:search-code', async (_, directoryPath: string, query: string, limit?: number) => {
  return getVectorSearchManager().searchCode(directoryPath, query, limit);
});

ipcMain.handle('vector-search:search-symbols', (_, directoryPath: string, name: string, symbolType?: string, limit?: number) => {
  return getVectorSearchManager().searchSymbols(directoryPath, name, symbolType as any, limit);
});

ipcMain.handle('vector-search:cancel-indexing', (_, indexId: string) => {
  getVectorSearchManager().cancelIndexing(indexId);
  return { success: true };
});
```

**Step 3: Forward events to renderer**

Add after creating mainWindow:
```typescript
const vsManager = getVectorSearchManager();

vsManager.on('indexing-progress', (progress) => {
  mainWindow?.webContents.send('vector-search:progress', progress);
});

vsManager.on('indexing-complete', (data) => {
  mainWindow?.webContents.send('vector-search:complete', data);
});

vsManager.on('indexing-error', (data) => {
  mainWindow?.webContents.send('vector-search:error', data);
});
```

**Step 4: Cleanup on app quit**

Add in app quit handler:
```typescript
disposeVectorSearchManager();
```

**Step 5: Verify build**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: add vector search IPC handlers"
```

---

### Task 4.2: Update Preload API

**Files:**
- Modify: `D:\Projects\claudelander\src\main\preload.ts`

**Step 1: Add vector search API methods**

Add to the electronAPI object:
```typescript
// Vector Search
getIndexStatus: (directoryPath: string) =>
  ipcRenderer.invoke('vector-search:get-index-status', directoryPath),

startIndexing: (directoryPath: string) =>
  ipcRenderer.invoke('vector-search:start-indexing', directoryPath),

searchCode: (directoryPath: string, query: string, limit?: number) =>
  ipcRenderer.invoke('vector-search:search-code', directoryPath, query, limit),

searchSymbols: (directoryPath: string, name: string, symbolType?: string, limit?: number) =>
  ipcRenderer.invoke('vector-search:search-symbols', directoryPath, name, symbolType, limit),

cancelIndexing: (indexId: string) =>
  ipcRenderer.invoke('vector-search:cancel-indexing', indexId),

onIndexingProgress: (callback: (progress: any) => void) => {
  const listener = (_: Electron.IpcRendererEvent, progress: any) => callback(progress);
  ipcRenderer.on('vector-search:progress', listener);
  return () => ipcRenderer.removeListener('vector-search:progress', listener);
},

onIndexingComplete: (callback: (data: any) => void) => {
  const listener = (_: Electron.IpcRendererEvent, data: any) => callback(data);
  ipcRenderer.on('vector-search:complete', listener);
  return () => ipcRenderer.removeListener('vector-search:complete', listener);
},

onIndexingError: (callback: (data: any) => void) => {
  const listener = (_: Electron.IpcRendererEvent, data: any) => callback(data);
  ipcRenderer.on('vector-search:error', listener);
  return () => ipcRenderer.removeListener('vector-search:error', listener);
},
```

**Step 2: Verify build**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat: expose vector search API to renderer"
```

---

### Task 4.3: Add MCP Tools

**Files:**
- Modify: `D:\Projects\claudelander\src\mcp-server\index.ts`

**Step 1: Add search_code tool**

Add after existing tool registrations:
```typescript
server.registerTool(
  'search_code',
  {
    title: 'Semantic Code Search',
    description: 'Search the codebase semantically using natural language queries. Returns relevant code chunks ranked by similarity.',
    inputSchema: {
      query: z.string().describe('Natural language query describing what code to find'),
      path: z.string().optional().describe('Optional: specific directory path to search'),
      limit: z.number().optional().default(10).describe('Maximum results to return'),
    },
  },
  async ({ query, path, limit }) => {
    try {
      const searchPath = path ?? process.cwd();
      const results = await apiGet<{ results: any[] }>(
        `/api/v1/code/search?q=${encodeURIComponent(query)}&path=${encodeURIComponent(searchPath)}&limit=${limit}`
      );

      if (results.results.length === 0) {
        return {
          content: [{ type: 'text', text: 'No matching code found.' }],
        };
      }

      const formatted = results.results.map((r, i) =>
        `### Result ${i + 1} (${Math.round(r.score * 100)}% match)\n` +
        `**File:** ${r.filePath}:${r.startLine}-${r.endLine}\n` +
        `\`\`\`\n${r.content}\n\`\`\``
      ).join('\n\n');

      return {
        content: [{ type: 'text', text: formatted }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error searching code: ${error}` }],
      };
    }
  }
);

server.registerTool(
  'find_symbol',
  {
    title: 'Find Symbol Definition',
    description: 'Find where a function, class, method, or other symbol is defined.',
    inputSchema: {
      name: z.string().describe('Name of the symbol to find'),
      path: z.string().optional().describe('Optional: specific directory path to search'),
      symbol_type: z.enum(['function', 'class', 'method', 'variable', 'interface', 'type']).optional()
        .describe('Optional: type of symbol to find'),
    },
  },
  async ({ name, path, symbol_type }) => {
    try {
      const searchPath = path ?? process.cwd();
      let url = `/api/v1/code/symbols?name=${encodeURIComponent(name)}&path=${encodeURIComponent(searchPath)}`;
      if (symbol_type) url += `&type=${symbol_type}`;

      const results = await apiGet<{ results: any[] }>(url);

      if (results.results.length === 0) {
        return {
          content: [{ type: 'text', text: `No symbol named "${name}" found.` }],
        };
      }

      const formatted = results.results.map(r =>
        `- **${r.symbolType}** \`${r.name}\` at ${r.filePath}:${r.line}:${r.column}` +
        (r.signature ? `\n  Signature: \`${r.signature}\`` : '')
      ).join('\n');

      return {
        content: [{ type: 'text', text: `Found ${results.results.length} definition(s):\n\n${formatted}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error finding symbol: ${error}` }],
      };
    }
  }
);
```

**Step 2: Build MCP server**

Run:
```bash
npm run build:mcp
```
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/mcp-server/index.ts
git commit -m "feat: add search_code and find_symbol MCP tools"
```

---

### Task 4.4: Add API Routes

**Files:**
- Create: `D:\Projects\claudelander\src\main\api\routes\code-search.ts`

**Step 1: Create code search routes**

```typescript
import { Router, Request, Response } from 'express';
import { getVectorSearchManager } from '../../vector-search';

export function createCodeSearchRouter(): Router {
  const router = Router();
  const manager = getVectorSearchManager();

  // Search code semantically
  router.get('/search', async (req: Request, res: Response) => {
    try {
      const { q, path, limit } = req.query;

      if (!q || typeof q !== 'string') {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }

      const searchPath = (path as string) ?? process.cwd();
      const searchLimit = parseInt(limit as string) || 10;

      const results = await manager.searchCode(searchPath, q, searchLimit);
      res.json({ results });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Search symbols
  router.get('/symbols', (req: Request, res: Response) => {
    try {
      const { name, path, type, limit } = req.query;

      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'Query parameter "name" is required' });
      }

      const searchPath = (path as string) ?? process.cwd();
      const searchLimit = parseInt(limit as string) || 20;

      const results = manager.searchSymbols(searchPath, name, type as any, searchLimit);
      res.json({ results });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Get index status
  router.get('/index/status', (req: Request, res: Response) => {
    try {
      const { path } = req.query;

      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'Query parameter "path" is required' });
      }

      const index = manager.getIndexStatus(path);
      res.json({ index });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Start indexing
  router.post('/index', async (req: Request, res: Response) => {
    try {
      const { path } = req.body;

      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'Body parameter "path" is required' });
      }

      await manager.startIndexing(path);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}
```

**Step 2: Register routes in API server**

Modify `src/main/api/index.ts` to add:
```typescript
import { createCodeSearchRouter } from './routes/code-search';

// In the server setup:
app.use('/api/v1/code', createCodeSearchRouter());
```

**Step 3: Verify build**

Run:
```bash
npm run build:main
```
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/main/api/routes/code-search.ts src/main/api/index.ts
git commit -m "feat: add code search API routes"
```

---

## Phase 5: UI

Due to the length of this plan, Phase 5 (UI components) and Phase 6 (Polish) are outlined but with less granular detail:

### Task 5.1: Create useCodeSearch Hook

**Files:**
- Create: `D:\Projects\claudelander\src\renderer\hooks\useCodeSearch.ts`

Implement React hook for code search state management.

### Task 5.2: Create CodeSearchModal Component

**Files:**
- Create: `D:\Projects\claudelander\src\renderer\components\CodeSearchModal.tsx`
- Create: `D:\Projects\claudelander\src\renderer\components\CodeSearchModal.css`

Implement the search modal with:
- Search input
- Toggle between semantic/symbol search
- Results list with file:line display
- "Open in Editor" and "Copy" buttons

### Task 5.3: Create IndexStatus Component

**Files:**
- Create: `D:\Projects\claudelander\src\renderer\components\IndexStatus.tsx`

Implement status indicator showing indexing state.

### Task 5.4: Add Editor Integration

**Files:**
- Create: `D:\Projects\claudelander\src\main\editor-launcher.ts`
- Modify: `D:\Projects\claudelander\src\main\preload.ts`

Implement editor detection and launching.

### Task 5.5: Add Context Injection

**Files:**
- Modify: `D:\Projects\claudelander\src\main\memory\injector.ts`

Add code search hint to context injection.

---

## Phase 6: Polish

### Task 6.1: Add Startup Reconciliation

Implement file mtime checking on session start.

### Task 6.2: Add Error Recovery

Implement retry logic and error UI states.

### Task 6.3: Add Settings UI

Add "Preferred Editor" setting.

### Task 6.4: Manual Testing Checklist

- [ ] Index a small project
- [ ] Verify semantic search returns relevant results
- [ ] Verify symbol search finds definitions
- [ ] Test file watcher updates index on changes
- [ ] Test "Open in Editor" functionality
- [ ] Test MCP tools via Claude Code

---

## Summary

This plan implements Semantic Code Search in 6 phases:

1. **Foundation** - Dependencies, types, database schema, repository
2. **Indexing Core** - File discovery, tree-sitter parsing, embedding provider
3. **Indexing Worker** - Background worker, VectorSearchManager
4. **Integration** - IPC handlers, preload API, MCP tools, API routes
5. **UI** - React hooks, modal component, status indicator
6. **Polish** - Reconciliation, error handling, settings

Each task is designed to be completed in 2-5 minutes with clear commit points.
