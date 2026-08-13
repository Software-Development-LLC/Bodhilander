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
   * 'codex', 'grok') (#96). Only meaningful when shellType is
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
  /** Conversation round: 0 = the run's initial prompt, 1+ = follow-ups. */
  round: number;
  /** The follow-up prompt this response answers (null on round 0 — see ArenaRun.prompt). */
  prompt: string | null;
  /**
   * CLI session/thread id this response can be resumed from (null when the
   * contestant has no resumable session, e.g. Ollama or an errored run).
   */
  sessionRef: string | null;
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
  /** Project folder the contestants ran in (null = no project context). */
  workingDir: string | null;
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

/**
 * Renderer-facing state of one provider's API-key vault entry (#99). The key
 * itself is never returned to the renderer — only whether one is stored.
 */
export interface KeyVaultStatus {
  providerId: string;
  /** Whether OS-keychain-backed encryption is available on this platform. */
  available: boolean;
  hasKey: boolean;
  /**
   * Whether the stored key is injected into launches for this provider.
   * Defaults to false — CLI login/subscription stays the default.
   */
  useKey: boolean;
}

/** Remote-hosting relay connection state, surfaced to the renderer. */
export interface RelayStatus {
  /** User has turned remote hosting on. */
  enabled: boolean;
  /** WebSocket is authenticated and the machine is online. */
  connected: boolean;
  /** Machine has been claimed by a user account on the relay. */
  linked: boolean;
  machineId: string | null;
  machineName: string | null;
  /** Relay origin, e.g. https://relay.example.com. */
  relayUrl: string;
  /** SSH-style identity fingerprint (SHA256:…) for out-of-band verification. */
  fingerprint: string | null;
  /** Keep this machine awake while remote hosting is on (so it stays reachable). */
  keepAwake: boolean;
  /**
   * The relay user id this machine's owner confirmed. Null until they have.
   * Session sharing needs it: without a confirmed owner the agent cannot tell
   * the owner apart from a guest.
   */
  ownerUserId: string | null;
  /** An owner the relay asserted that is still waiting on a human decision. */
  pendingOwner: { userId: string; displayName: string | null; email: string | null; isChange: boolean } | null;
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
  /** Runnable install command Bodhilander can execute for the user, when one exists. */
  installCommand: string | null;
  docsUrl: string;
  loginHint: string;
}

/**
 * Emitted when a provider session's CLI failed to launch (missing from PATH,
 * or installed-but-broken — e.g. codex's native binary absent). The renderer
 * shows a friendly banner with the install guidance instead of leaving the
 * user to decode a raw `spawn ... ENOENT`.
 */
export interface ProviderInstallHint {
  sessionId: string;
  providerId: string;
  providerName: string;
  /** CLI binary name (e.g. 'codex'). */
  command: string;
  kind: 'missing' | 'broken';
  installHint: string;
  installCommand: string | null;
  docsUrl: string;
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
  grok: 'Grok',
  opencode: 'opencode',
  kimi: 'Kimi',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
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

/**
 * Outcome of reassigning a Claude account to a session or group (BDHLNDR-31).
 * CLAUDE_CONFIG_DIR is fixed when a pty spawns, so the listed sessions must be
 * restarted before the switch takes effect on them.
 */
export interface AccountSwitchResult {
  affectedSessionIds: string[];
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
}

export interface DevicePermissions {
  canControl?: boolean;
  canModify?: boolean;
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
