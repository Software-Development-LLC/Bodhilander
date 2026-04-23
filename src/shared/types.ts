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
}

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
// Sharing Types
// =============================================================================
// These types use `string` for dates (ISO 8601 format) because they represent
// data from JSON API responses from the relay server. In contrast, the local
// Session/Group types above use `Date` objects because they are managed as
// local application state.
// =============================================================================

/**
 * The authenticated user from OAuth, stored locally.
 * This represents YOU when you are sharing or joining sessions.
 * Compare with GuestInfo which represents others connected to your session.
 */
export interface ShareUser {
  id: string;
  username: string;
  email?: string;
  tier: 'free' | 'pro' | 'admin';
}

export interface ShareSession {
  id: string;
  hostPublicKey: string;
  startedAt: string;
  codes: ShareCode[];
}

export interface ShareCode {
  code: string;
  permission: 'read' | 'control';
  /** Maximum number of times this code can be used. `null` means unlimited. */
  maxUses: number | null;
  currentUses: number;
  /** When this code expires (ISO 8601). `null` means no expiration. */
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateCodeOptions {
  permission: 'read' | 'control';
  maxUses?: number;
  expiresInMinutes?: number;
}

export interface SharedSessionInfo {
  sessionId: string;
  hostUsername: string;
  permission: 'read' | 'control';
  connectedAt: Date;
}

/**
 * A guest connected to YOUR shared session, as reported by the relay server.
 * This represents OTHER users who have joined your session using a share code.
 * Compare with ShareUser which represents the authenticated local user.
 */
export interface GuestInfo {
  userId: string;
  username: string;
  permission: 'read' | 'control';
  publicKey: string;
}

// =============================================================================
// Mobile API Server Types
// =============================================================================
// Types for the local API server that enables mobile companion app connectivity
// =============================================================================

export interface RelayConnectionStatus {
  enabled: boolean;
  connected: boolean;
  desktopId: string | null;
  relayUrl: string;
}

export interface ApiServerStatus {
  running: boolean;
  port?: number;
  addresses?: string[];
  relay?: RelayConnectionStatus;
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
