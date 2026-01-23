# Semantic Code Search - Design Document

**Date:** 2026-01-23
**Status:** Approved
**Version:** 1.0

## Overview

A self-contained semantic code search system for ClaudeLander that enables Claude (and users) to search codebases by meaning, not just keywords. Includes both vector-based semantic search and precise symbol lookup.

### Goals

- **"It just works"** - Auto-indexes on session start, stays fresh with file watching
- **Self-contained** - No external services, works offline
- **Quality over size** - Ship a capable model, don't compromise on search quality
- **Dual search modes** - Semantic search for concepts, symbol lookup for precision

### Non-Goals (v1)

- Cross-file reference tracking
- Full call hierarchy analysis
- Cloud-based embedding providers (deferred to v2)

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        ClaudeLander                              │
├─────────────────────────────────────────────────────────────────┤
│  Main Process                                                    │
│  ├── VectorSearchManager (new)                                  │
│  │   ├── Indexer (tree-sitter + ONNX embeddings)               │
│  │   ├── FileWatcher (chokidar)                                │
│  │   └── SearchEngine (sqlite-vec queries)                     │
│  ├── database.ts (extended with vector tables)                  │
│  └── pty-manager.ts (unchanged)                                 │
│                                                                  │
│  MCP Server                                                      │
│  └── search_code, find_symbol tools (new)                       │
│                                                                  │
│  Renderer                                                        │
│  └── CodeSearchModal (new)                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. Session opens → check if working_dir is indexed
2. If not indexed → queue background indexing job
3. Indexer: parse files → chunk by syntax → generate embeddings → store in sqlite-vec
4. File watcher: detect changes → re-embed affected chunks
5. Search (via MCP or UI): embed query → vector similarity search → return ranked results

### New Dependencies

| Package | Purpose |
|---------|---------|
| `onnxruntime-node` | Native ONNX inference for embeddings |
| `tree-sitter` | Syntax parsing for intelligent chunking |
| `tree-sitter-typescript` | TypeScript/JavaScript grammar |
| `tree-sitter-python` | Python grammar |
| `tree-sitter-c-sharp` | C# grammar |
| `sqlite-vec` | Vector similarity search in SQLite |
| `chokidar` | File system watching |

---

## Database Schema

### New Tables

```sql
-- Indexed directories (one per unique working_dir)
CREATE TABLE code_indexes (
  id TEXT PRIMARY KEY,
  directory_path TEXT UNIQUE NOT NULL,
  last_indexed_at TEXT,
  status TEXT CHECK(status IN ('pending', 'indexing', 'ready', 'error')),
  file_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  model_name TEXT DEFAULT 'default',
  embedding_dimensions INTEGER DEFAULT 384,
  error_message TEXT
);

-- Code chunks with embeddings
CREATE TABLE code_chunks (
  id TEXT PRIMARY KEY,
  index_id TEXT NOT NULL REFERENCES code_indexes(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  chunk_type TEXT,
  embedding BLOB,
  created_at TEXT
);

-- Symbol definitions (functions, classes, methods)
CREATE TABLE symbols (
  id TEXT PRIMARY KEY,
  index_id TEXT NOT NULL REFERENCES code_indexes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  symbol_type TEXT CHECK(symbol_type IN ('function', 'class', 'method', 'variable', 'interface', 'type')),
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  column INTEGER NOT NULL,
  parent_symbol_id TEXT REFERENCES symbols(id),
  signature TEXT,
  created_at TEXT
);

-- Indexes for fast lookups
CREATE INDEX idx_chunks_index_id ON code_chunks(index_id);
CREATE INDEX idx_chunks_file_path ON code_chunks(file_path);
CREATE INDEX idx_symbols_index_id ON symbols(index_id);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file_path ON symbols(file_path);

-- Vector similarity search (sqlite-vec)
CREATE VIRTUAL TABLE code_chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[384]
);
```

---

## Indexing Pipeline

### File Discovery

```
Working Directory
       │
       ▼
┌─────────────────────┐
│  File Discovery     │
│  - Respect .gitignore
│  - Respect .claudeignore (optional)
│  - Filter by extension
│  - Skip: node_modules, dist, .git, binaries
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  Parse & Chunk      │
│  - tree-sitter for TS/JS, Python, C#
│  - Extract: functions, classes, methods
│  - Fallback: fixed-size (~50 lines)
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  Symbol Extraction  │
│  - Function/class/method names
│  - Signatures
│  - Line & column positions
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  Embedding          │
│  - Batch chunks (32 at a time)
│  - EmbeddingProvider.embed()
│  - Progress callback for UI
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  Storage            │
│  - Insert into SQLite
│  - Update index status
└─────────────────────┘
```

### Indexing Triggers

| Trigger | Behavior |
|---------|----------|
| Session start | Auto-index working_dir if not already indexed |
| File change | Debounce 500ms, re-index single file |
| Branch switch | Detect >50 files changed → full re-index |
| Manual button | User-triggered re-index |

### Resource Limits

```typescript
const LIMITS = {
  maxFileSize: 1 * 1024 * 1024,      // 1MB - skip larger files
  maxFilesPerIndex: 50_000,          // Safety cap
  maxChunksPerFile: 500,             // Prevent runaway chunking
  embeddingBatchSize: 32,            // Balance speed vs memory
  watcherDebounceMs: 500,            // Prevent thrashing
  branchSwitchThreshold: 50,         // Files changed → full re-index
};
```

---

## Embedding Provider Architecture

### Interface

```typescript
interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

### V1 Implementation

- `OnnxEmbeddingProvider` - Default, ships with app, works offline
- Code-specialized model (~100-400MB)

### Future Providers (v2)

- `OllamaEmbeddingProvider` - Local Ollama API
- `OpenAIEmbeddingProvider` - Cloud option
- `VoyageEmbeddingProvider` - Cloud option

### Model Switching

- Index stores `model_name` and `embedding_dimensions`
- Changing provider requires re-indexing
- Settings UI for power users to select provider

---

## MCP Tools

### search_code

Semantic search for code by meaning.

```typescript
{
  name: "search_code",
  description: "Semantically search the codebase for relevant code.",
  parameters: {
    query: string,           // Natural language query
    path?: string,           // Optional: specific directory (for worktrees)
    limit?: number,          // Default: 10
    file_filter?: string,    // Optional: glob pattern
  },
  returns: {
    results: [{
      file_path: string,
      start_line: number,
      end_line: number,
      content: string,
      score: number,
      chunk_type: string,
    }]
  }
}
```

### find_symbol

Precise symbol definition lookup.

```typescript
{
  name: "find_symbol",
  description: "Find where a function, class, or method is defined.",
  parameters: {
    name: string,            // Exact symbol name
    path?: string,           // Optional: limit to directory
    symbol_type?: string,    // Optional: 'function', 'class', etc.
  },
  returns: {
    results: [{
      name: string,
      symbol_type: string,
      file_path: string,
      line: number,
      column: number,
      signature: string,
    }]
  }
}
```

### Context Injection

When an index exists for the session's working directory:

```
<code-search>
This project is indexed for semantic code search.
- Use 'search_code' for conceptual queries: "find authentication logic"
- Use 'find_symbol' for precise lookups: "find definition of validateToken"
</code-search>
```

---

## User Interface

### Index Status Indicator

Per session/group, showing:
- `○ Not indexed` - grey, with "Index" button
- `◐ Indexing... 45%` - animated progress
- `● Indexed (1,247 chunks, 892 symbols)` - green
- `● Index outdated` - yellow
- `✕ Index error` - red with retry

### Code Search Modal

Triggered by keyboard shortcut (Ctrl+Shift+F) or toolbar icon.

```
┌─────────────────────────────────────────────────────────┐
│  🔍 Search codebase                              [X]    │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐   │
│  │ where is user authentication handled           │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─ Results ──────────────────────────────────────────┐│
│  │ 📄 src/services/auth.ts:45-78          92% match  ││
│  │    function authenticateUser(token: string)...    ││
│  │                       [Open in VS Code] [Copy]    ││
│  └────────────────────────────────────────────────────┘│
│                                                         │
│  [Toggle: Semantic search ◉ | Symbol lookup ○ ]        │
└─────────────────────────────────────────────────────────┘
```

### Editor Integration

Settings: "Preferred Editor" dropdown (auto-detected on first run)

| Editor | Command |
|--------|---------|
| VS Code | `code --goto file:line:column` |
| Zed | `zed file:line` |
| Cursor | `cursor --goto file:line:column` |
| Sublime | `subl file:line` |
| JetBrains | `idea --line line file` |

---

## Error Handling

### Indexing Errors

| Scenario | Handling |
|----------|----------|
| File permission denied | Skip file, log warning, continue |
| tree-sitter parse failure | Fall back to fixed-size chunking |
| Embedding model fails | Show error in UI, disable indexing |
| Out of disk space | Stop, set status to 'error', show message |
| Very large file (>1MB) | Skip with warning |
| Binary file | Skip automatically |

### Search Errors

| Scenario | Handling |
|----------|----------|
| Index not ready | Return status and progress |
| Index doesn't exist | Return hint to index first |
| No results | Return empty array (not error) |

### File Watcher Edge Cases

| Scenario | Handling |
|----------|----------|
| Rapid saves | Debounce 500ms |
| Branch switch | Full re-index if >50 files change |
| File renamed | Delete + create |
| .gitignore changed | Re-scan file list |

---

## V2 Roadmap

Explicitly deferred for future development:

### Symbol Navigation Enhancements
- Cross-file import/export tracking
- Full "find all references" across codebase
- Call hierarchy analysis
- Type hierarchy for classes

### Embedding Provider Expansion
- Ollama provider
- OpenAI/Voyage API providers
- Provider comparison tooling

### Smarter Indexing
- Auto-detect worktree creation
- Track working directory changes during session
- Diff-based re-indexing on branch switch
- Summarized dependency indexing

### Search Enhancements
- Hybrid search (vector + keyword)
- Search history and saved queries
- "Similar code" search

### UI Enhancements
- Inline code preview
- Keyboard shortcuts
- Result grouping by file/directory

---

## Implementation Notes

### Index Scope

Index is keyed by **canonical directory path**, not by group or session.

- Multiple sessions sharing same working_dir → share index
- Sessions in worktrees → get separate indexes
- MCP tools accept optional `path` parameter for worktree scenarios

### Language Support (v1)

| Language | Parser | Chunking |
|----------|--------|----------|
| TypeScript | tree-sitter-typescript | Syntax-aware |
| JavaScript | tree-sitter-javascript | Syntax-aware |
| Python | tree-sitter-python | Syntax-aware |
| C# | tree-sitter-c-sharp | Syntax-aware |
| Other | N/A | Fixed-size fallback |

### Storage Estimates

- 1 chunk ≈ 1.5 KB (384-dim embeddings)
- Typical file: 30 chunks ≈ 45 KB
- 1,000 file codebase: ~45 MB vector data
- Fits comfortably in SQLite

---

## Appendix: File Filtering

### Default Ignores

```
node_modules/
dist/
build/
.git/
*.min.js
*.map
*.lock
```

### Supported Extensions (v1)

```
.ts, .tsx, .js, .jsx, .mjs, .cjs
.py, .pyw
.cs
.json (chunked, not parsed)
.md (chunked, not parsed)
```

### Custom Ignores

Users can create `.claudeignore` in project root with gitignore syntax.
