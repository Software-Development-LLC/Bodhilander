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
  /**
   * Derived at read time, never stored: `workingDir` is not on this machine,
   * so launching would throw. A stored flag could not survive the bulk state
   * reset every app start performs.
   */
  workingDirMissing?: boolean;
  /**
   * The account this session was moved OFF when failover fired (#207), or null
   * when it is running where it was put. Kept so the session can go back once
   * that account's limit lifts, and so the UI can say why it moved.
   */
  failoverFromAccountId: string | null;
  /**
   * The value `claudeAccountId` held before failover overwrote it. NULL means
   * "inherited from the group", which is why it cannot double as the "no
   * failover in progress" signal — `failoverFromAccountId` is that signal.
   */
  failoverPrevAccountId: string | null;
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
  /**
   * Guests attached right now, and what each is watching.
   *
   * Presence is a hard requirement of session sharing: silent read access to a
   * live terminal is the same class of harm as silent write access.
   */
  attachedGuests: RelayAttachedGuest[];
  /** Share requests waiting on this machine's owner to answer. */
  pendingShares: RelayPendingShare[];
}

/**
 * A guest asking for a session to be resized to fit their screen. Mirrors the
 * tunnel's `GuestResizeRequest`, and is a request and nothing else: it becomes
 * a prompt the owner may decline, leaving the guest's view exactly as it was.
 */
export interface RelayResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
  /** Who is asking. Relay-asserted identity, never authorization. */
  login: string | null;
  displayName: string | null;
}

export interface RelayAttachedGuest {
  clientId: string;
  grantId: string | null;
  role: string;
  login: string | null;
  displayName: string | null;
  /** Sessions they are watching right now, not merely entitled to. */
  sessionIds: string[];
}

/** An active or revoked share, as the owner's settings list shows it. */
export interface RelayShare {
  grantId: string;
  role: string;
  status: 'pending' | 'active' | 'revoked';
  granteeLogin: string | null;
  createdAt: number;
  expiresAt: number | null;
  /** True while a revocation is queued for a relay we could not reach. */
  revokePending: boolean;
  sessionIds: string[];
}

export interface RelayPendingShare {
  grantId: string;
  role: string;
  /** The immutable handle. Shown instead of a display name, which is free text. */
  granteeLogin: string | null;
  granteeName: string | null;
  createdAt: number;
  /** The session the invite was offered for, if this machine still knows it. */
  sessionId: string | null;
  sessionName: string | null;
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
  /** Address last recorded for this account, for display. */
  email: string | null;
  /**
   * Whether a completed login was found — resolved from the config dir, and
   * from a recorded address only where that dir could not be read. Undefined
   * when nothing was consulted, so no surface may call the account logged out.
   */
  loggedIn?: boolean;
  /** Hex color for UI badge. */
  color: string;
  /** True for the single account used as the global default fallback. */
  isDefault: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  /**
   * Position in the failover order (#207): when an account hits its usage
   * limit, its live sessions move to the lowest-ranked healthy account. Null
   * for accounts that have never been ranked, which sort after every ranked
   * one in the list order the accounts panel already uses.
   */
  fallbackRank: number | null;
  /**
   * When this account's usage limit is expected to lift, or null when it is
   * not currently limited (#207). An account is skipped as a failover target
   * until this passes. Parsed out of the CLI's own "resets at" line where it
   * says one, otherwise a conservative default window.
   */
  limitedUntil: Date | null;
  /** When the limit was observed. Null whenever limitedUntil is null. */
  limitedAt: Date | null;
}

/**
 * One automatic account switch (#207), reported to the renderer so it can
 * respawn the ptys and say what happened.
 *
 * `to` is null when there was nowhere to go: every other account is limited
 * too, or none is registered. That is not a failure to report as an error —
 * the session stays where it is and the user is told the wall is real.
 */
export interface AccountFailoverEvent {
  /** 'limit' = moved off an exhausted account; 'failback' = returned to it. */
  reason: 'limit' | 'failback';
  from: ClaudeAccount | null;
  to: ClaudeAccount | null;
  /** Sessions whose pty must be respawned for the switch to take effect. */
  sessionIds: string[];
  /** When `from`'s limit lifts, for the notification copy. Null if unknown. */
  resetAt: Date | null;
  /** Why nothing moved, when `to` is null. */
  blocked?: 'no-healthy-account';
}

/**
 * Outcome of reassigning a Claude account to a session or group (BDHLNDR-31).
 * CLAUDE_CONFIG_DIR is fixed when a pty spawns, so the listed sessions must be
 * restarted before the switch takes effect on them.
 */
export interface AccountSwitchResult {
  affectedSessionIds: string[];
  /**
   * What the write did, beyond what needs restarting (#214).
   *
   * `affectedSessionIds` answers one question — which ptys to replace — and
   * answers it with `[]` in two very different situations: nothing needed to
   * move, and nothing could. Both reach the user as an unchanged screen,
   * indistinguishable from a menu that never registered the click. This is
   * what the renderer needs to say which one it was.
   */
  outcome: AccountSwitchOutcome;
}

/**
 * Why an account switch moved what it moved (#214).
 *
 * Deliberately describes sessions rather than prescribing a message: "already
 * on that account" and "pinned to its own account" are different facts about
 * the user's setup, and only the renderer knows which of them is worth saying
 * in the surface the click came from.
 */
export interface AccountSwitchOutcome {
  /** The account the target resolves to after the write (null = legacy dir). */
  account: ClaudeAccount | null;
  /**
   * Sessions whose effective account did not move. For a session switch this
   * is the session itself, meaning the pick recorded an override to the
   * account it was already inheriting.
   */
  unchangedSessionIds: string[];
  /**
   * Group switches only: sessions carrying their own account override, which
   * a group-level change cannot move by design. Worth separating from the
   * above because the reason is different and so is the remedy.
   */
  overriddenSessionIds: string[];
}

/**
 * The Claude account a RUNNING pty actually launched under (#165).
 *
 * CLAUDE_CONFIG_DIR is baked into the pty when it spawns (PtyManager's
 * buildAgentSpawn), so `Session.claudeAccountId` — and the group/default chain
 * behind it — describes what a session WILL run under, never what it IS
 * running under. The two disagree from the moment an account is switched until
 * the pty respawns, and #164 made that gap invisible: switching a live session
 * looked like a no-op while the old account kept being billed. This is the
 * spawn-time truth, published so the UI can name the account actually in use.
 */
export interface LiveAccountBinding {
  /**
   * Registered account the pty spawned under, or null when it spawned with no
   * CLAUDE_CONFIG_DIR at all — the legacy ~/.claude login that predates
   * accounts (BDHLNDR-31). Consumers join this against the accounts list for
   * label/email/color rather than reading a snapshot, so a rename shows up
   * without waiting for a respawn.
   */
  accountId: string | null;
  /**
   * The config dir that actually reached the CLI. claude_accounts.config_dir is
   * UNIQUE in the schema, so this still identifies the login even if the row
   * was renamed or deleted after the pty spawned.
   */
  configDir: string;
  /**
   * Wall-clock spawn time (ms) of the pty this binding describes. Changes on
   * every respawn — including the silent resume-failure respawn — so a viewer
   * can tell "same pty, account renamed" from "new pty, new account".
   */
  spawnedAt: number;
}

/**
 * Live account bindings for every session with a running agent pty, keyed by
 * session id (#165). A session absent from the map has no pty running under
 * any account: nothing is being billed for it right now.
 */
export type LiveAccountBindings = Record<string, LiveAccountBinding>;

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

export interface PortableExportResult {
  success: boolean;
  filePath?: string;
  error?: string;
  groupCount?: number;
  sessionCount?: number;
  /** Archive size as it was shown before the file was written; bundles only. */
  sizeLabel?: string;
}

export interface PortableImportResult {
  success: boolean;
  error?: string;
  groupCount?: number;
  sessionCount?: number;
  skippedGroups?: number;
  skippedSessions?: number;
  /** Bundles only: transcripts landed, and sessions whose folder is missing. */
  transcriptCount?: number;
  needsRelinkCount?: number;
}

export interface TransferBundleCounts {
  groups: number;
  sessions: number;
  sessionEvents: number;
  chatEvents: number;
  arenaRuns: number;
  arenaResponses: number;
  preferences: number;
  accounts: number;
  transcripts: number;
}

export interface TransferBundleManifest {
  formatVersion: number;
  sourceApp: string;
  sourceAppVersion: string;
  sourcePlatform: string;
  /** The userData root the bundle came from, recorded for diagnostics. */
  sourceUserData: string;
  exportedAt: string;
  /** Distinct roots across every group and session working directory. */
  workingDirRoots: string[];
  counts: TransferBundleCounts;
}
