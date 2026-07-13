export type SessionState = 'idle' | 'working' | 'waiting' | 'error' | 'stopped';

export interface Session {
  id: string;
  groupId: string;
  name: string;
  workingDir: string;
  state: SessionState;
  shellType: string;
  order: number;
  createdAt: Date;
  lastActivityAt: Date;
  /**
   * Claude Code session UUID for conversation resume across restarts (BDHLNDR-9).
   * Null for non-Claude sessions or Claude sessions that have not been launched yet.
   */
  claudeSessionId: string | null;
  /** When the session was stopped/ended (BDHLNDR-17). Null if still active. */
  endedAt: Date | null;
  /** Active time in seconds (working + waiting states), not wall clock (BDHLNDR-17). */
  durationSeconds: number;
  /**
   * Optional Claude account override for this session (BDHLNDR-31). When null,
   * the session inherits from its group (and if the group has none, falls back
   * to the global default account, then to the legacy ~/.claude config).
   */
  claudeAccountId: string | null;
  /**
   * Agent provider this session runs (providers registry id: 'claude',
   * 'codex', 'gemini', 'grok') (#96). Only meaningful when shellType is
   * 'claude'; plain shell sessions keep the default.
   */
  provider: string;
}

// ---------------------------------------------------------------------------
// Arena mode (#100) — one prompt fanned out to multiple agents, compared.
// ---------------------------------------------------------------------------

export type ArenaResponseStatus = 'running' | 'done' | 'error';

export interface ArenaResponse {
  id: string;
  runId: string;
  /** Arena contestant id: a provider registry id or 'ollama'. */
  provider: string;
  status: ArenaResponseStatus;
  /** Accumulated response text (streamed). */
  text: string;
  /** Milliseconds from spawn to first output. Null until first chunk. */
  ttftMs: number | null;
  /** Milliseconds from spawn to completion. Null while running. */
  totalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * API-equivalent cost in USD when the CLI reports one (subscription-backed
   * runs don't bill this; it's shown as "included in subscription"). Null
   * when the CLI doesn't report cost.
   */
  costUsd: number | null;
  /** Error detail when status === 'error'. */
  error: string | null;
}

export interface ArenaRun {
  id: string;
  prompt: string;
  createdAt: Date;
  responses: ArenaResponse[];
}

/** Renderer-facing progress event for a streaming arena response. */
export interface ArenaUpdate {
  runId: string;
  responseId: string;
  provider: string;
  /** New text appended since the last update (may be empty on status-only updates). */
  chunk: string;
  status: ArenaResponseStatus;
  ttftMs: number | null;
  totalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  error: string | null;
}

/** Result of probing one provider CLI's availability (#97). */
export interface ProviderStatus {
  id: string;
  name: string;
  /** CLI binary probed for. */
  command: string;
  installed: boolean;
  /** First version-looking line of `<command> --version`, when available. */
  version: string | null;
  installHint: string;
  docsUrl: string;
  loginHint: string;
}

/**
 * Default provider for new sessions. Must match the main-process registry's
 * DEFAULT_PROVIDER_ID (the registry lives main-side because provider
 * definitions import electron; the renderer only needs the id).
 */
export const DEFAULT_SESSION_PROVIDER = 'claude';

/** Display labels for session providers (registry ids → short names). */
export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  grok: 'Grok',
};

export interface Group {
  id: string;
  name: string;
  color: string;
  workingDir: string;
  order: number;
  createdAt: Date;
  parentId: string | null;
  collapsed: boolean;
  /**
   * Default Claude account for sessions in this group (BDHLNDR-31). Sessions
   * inherit this unless they set their own claudeAccountId.
   */
  claudeAccountId: string | null;
}

/**
 * A Claude.ai account registered with Bodhilander (BDHLNDR-31). Each account
 * owns an isolated CLAUDE_CONFIG_DIR so that multiple accounts can run
 * concurrent sessions without credential contention.
 */
export interface ClaudeAccount {
  id: string;
  /** Human-readable label (e.g. "Personal", "Acme Corp"). */
  label: string;
  /** Absolute path to the account's isolated .claude directory. */
  configDir: string;
  /** Email parsed from credentials after login, for display. */
  email: string | null;
  /** Hex color for UI badge. */
  color: string;
  /** True for the single account used as the global default fallback. */
  isDefault: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface AppState {
  groups: Group[];
  sessions: Session[];
  activeSessionId: string | null;
}

// =============================================================================
// Mobile API Server Types
// =============================================================================
// Types for the local API server that enables mobile companion app connectivity
// =============================================================================

export interface ApiServerStatus {
  running: boolean;
  port?: number;
  addresses?: string[];
}

export interface PairingCode {
  code: string;
  qrCode: string;
  expiresAt: number;
  addresses?: string[];
  port?: number;
}

export interface PairedDevice {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastUsedAt: string;
  canControl: boolean;
  canModify: boolean;
}

export interface ApiServerConfig {
  port?: number;
  enableMdns?: boolean;
}

export interface DevicePermissions {
  canControl?: boolean;
  canModify?: boolean;
}

// =============================================================================
// Memory Types
// =============================================================================
// Types for session memory/knowledge persistence feature
// =============================================================================

/**
 * Reserved group ID for global context that applies to all projects.
 * Memories with this group_id are injected into every session.
 */
export const GLOBAL_CONTEXT_GROUP_ID = '__global__';

export type MemoryType = 'decision' | 'error_fix' | 'pattern' | 'context' | 'note';
export type MemorySource = 'auto' | 'manual' | 'claude';

export interface Memory {
  id: string;
  sessionId: string | null;
  groupId: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  tags: string[];
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}

export interface MemoryCreateInput {
  id: string;
  sessionId: string | null;
  groupId: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  tags?: string[];
  pinned?: boolean;
}

export interface MemoryUpdateInput {
  content?: string;
  type?: MemoryType;
  tags?: string[];
  pinned?: boolean;
}

export interface MemoryEvent {
  type: 'memory';
  sessionId: string;
  memory: {
    type: MemoryType;
    content: string;
    source: 'claude';
  };
  timestamp: number;
}

// =============================================================================
// Session Event Types (BDHLNDR-17)
// =============================================================================
// Types for session event tracking and analytics
// =============================================================================

export type SessionEventType = 'session_start' | 'session_stop' | 'state_change' | 'tool_use' | 'turn_complete' | 'error' | 'notification';

export interface SessionEvent {
  id: string;
  sessionId: string;
  eventType: SessionEventType;
  eventData: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SessionStats {
  totalEvents: number;
  totalDurationSeconds: number;
  toolUseCounts: Record<string, number>;
  stateBreakdown: Record<string, number>; // state name → seconds
}

export interface GlobalStats {
  totalSessions: number;
  totalEvents: number;
  totalDurationSeconds: number;
  eventsPerDay: { date: string; count: number }[];
  toolUseCounts: Record<string, number>;
}

// =============================================================================
// Code Search Types
// =============================================================================
// Types for semantic code search and symbol lookup feature
// =============================================================================

export type ChunkType = 'function' | 'class' | 'method' | 'interface' | 'type' | 'block';
export type SymbolType = 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type';
export type IndexStatus = 'pending' | 'indexing' | 'ready' | 'error' | 'stale';

export interface CodeIndex {
  id: string;
  directoryPath: string;
  lastIndexedAt: Date | null;
  status: IndexStatus;
  fileCount: number;
  chunkCount: number;
  symbolCount: number;
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

export type IndexPhase = 'parsing' | 'embedding';

export interface IndexProgress {
  indexId: string;
  directoryPath: string;
  status: IndexStatus;
  phase: IndexPhase;
  filesTotal: number;
  filesIndexed: number;
  currentFile: string | null;
  error: string | null;
}
