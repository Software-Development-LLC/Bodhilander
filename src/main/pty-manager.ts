import * as pty from 'node-pty';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
  resolveProvider,
  getSocketPath,
  generateAgentSessionId,
  claudeProvider,
  CLAUDE_CONFIG_DIR_ENV,
  DEFAULT_PROVIDER_ID,
  AgentSessionMode,
  ProviderDefinition,
} from './providers';
import { detectShell, ShellInfo } from './shell-detector';
import { classifySpawnFailure } from './spawn-failure';
import { LiveAccountBinding, LiveAccountBindings, ProviderInstallHint } from '../shared/types';
import { getShellLaunch } from './shell-launch';
import {
  ensureTranscriptInConfigDir,
  isPathSafeConversationId,
  legacyClaudeConfigDir,
  type TranscriptCarryResult,
} from './conversation-transcript';
import { getPreference } from './repositories/preferences';
import {
  getClaudeSessionId as getStoredClaudeSessionId,
  setClaudeSessionId as storeClaudeSessionId,
  clearClaudeSessionId as clearStoredClaudeSessionId,
} from './repositories/sessions';
import { getAllAccounts, touchAccount } from './repositories/accounts';
import { resolveAccountForSession } from './account-resolver';
import { readQuotaLimit } from './quota-limit';
import { vaultEnvFor } from './key-vault';
import { redactEnv } from './redact-env';
import log from 'electron-log';

interface PtySession {
  id: string;
  pty: pty.IPty;
  cwd: string;
  /** Provider this session runs an agent under; null for plain shell sessions. */
  provider: ProviderDefinition | null;
  shellInfo: ShellInfo;
  lastState: string;
  outputBuffer: string;
  scrollbackBuffer: string;  // Larger buffer for terminal history
  /**
   * Every character ever appended to `scrollbackBuffer`, including what the
   * cap has since evicted. `scrollbackBuffer` is a sliding window, so an
   * index into it stops meaning the same thing the moment it trims; this
   * counter is what makes a mark taken now still resolvable later.
   */
  scrollbackTotal: number;
  idleTimeout: NodeJS.Timeout | null;
  workingDebounce: NodeJS.Timeout | null;
  recentOutputBytes: number;
  lastOutputTime: number;
  /** Whether this spawn used the provider's resume flag. Used to detect resume failure on early exit. */
  resumeAttempted: boolean;
  /** Wall-clock spawn time (ms) for early-exit detection. */
  spawnedAt: number;
  /**
   * What the launch-time transcript staging found for this pty's conversation
   * (#164), or null when it never ran (no resume, or a provider without
   * accounts). The resume-failure fallback reads it before deciding whether a
   * non-zero exit is evidence that the stored conversation id is dead.
   */
  transcriptStaged: TranscriptCarryResult | null;
  /**
   * The account this pty ACTUALLY spawned under (#165), or null for providers
   * that don't read CLAUDE_CONFIG_DIR. Nothing else records it — the env var is
   * fixed at spawn and the DB only holds the assignment — so without this the
   * UI can only report what a session WILL run under.
   */
  liveAccount: LiveAccountBinding | null;
  /** Last known column/row count — used to detect actual size changes. */
  lastCols: number;
  lastRows: number;
  /** Set to true when kill() is in progress — guards against use-after-free on native PTY handle. */
  killing: boolean;
  /**
   * Set once a launch-failure hint has been emitted for this session, so the
   * renderer sees at most one banner per spawn.
   */
  spawnFailureNotified: boolean;
  /**
   * Output retained for launch-failure classification. Separate from
   * scrollbackBuffer, whose tail-keeping 100KB trim could evict an early
   * failure line behind a chatty startup. This buffer keeps output from the
   * HEAD (capped at LAUNCH_OUTPUT_CAP) and is emptied once the failure
   * window passes or a hint fires, so it never outlives spawn diagnosis.
   */
  launchOutput: string;
  /**
   * When true, incoming pty output is accumulated in scrollbackBuffer but NOT
   * emitted as 'data' events (BDHLNDR-33). Used by the interactive-login pty
   * to avoid losing startup output in the window between pty spawn and the
   * renderer attaching its listener. Flipped to false by primePty() once the
   * renderer signals it's ready; primePty emits the buffered scrollback as a
   * single 'data' event first, guaranteeing ordered delivery.
   */
  deferEmission: boolean;
  /**
   * Set once this pty has reported a usage limit, so the TUI repainting the
   * same message forty times a second produces one failover and not forty.
   *
   * Per-pty, not per-session: the flag lives and dies with the process, so the
   * replacement pty spawned by a failover can report its own limit if the
   * account it landed on turns out to be exhausted too.
   */
  usageLimitReported: boolean;
  /** Last time the transcript was consulted, to bound the read rate. */
  quotaCheckedAt: number;
}

/**
 * A kill() call still waiting for its process to die (#164). Keyed by session
 * id but holding the pty it was issued against, so a late exit can only settle
 * the kill that actually asked for it.
 */
interface PendingKill {
  pty: pty.IPty;
  promise: Promise<void>;
  /**
   * Release the waiter. `keepReaper` hands the entry off without disarming the
   * force timer, for the one caller that stops tracking a process it has not
   * seen die — cancelling the escalation there would leak the process outright.
   */
  settle: (opts?: { keepReaper?: boolean }) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * If an agent session launched with the provider's resume flag exits non-zero
 * within this window, we treat it as a resume failure and transparently
 * respawn with a fresh conversation UUID (BDHLNDR-9).
 */
const RESUME_FAILURE_WINDOW_MS = 5000;

// Max scrollback buffer replayed to remote viewers (web/phone) on attach. This
// is the ONLY history a remote viewer can see — it has no live stream from before
// it connected — so it needs to be generous. 100KB is barely one screen on a
// wide terminal (e.g. 184 cols), which left the phone with nothing to scroll. 2MB
// holds thousands of lines even on a wide terminal.
const MAX_SCROLLBACK_SIZE = 2 * 1024 * 1024;

/**
 * Append PTY output to a session's replay buffer, trimming to the cap. The trim
 * is amortized: we only slice once the buffer grows 25% past the cap (then cut
 * back to the cap), so a chatty PTY doesn't pay an O(cap) string copy on every
 * single chunk once it's full.
 */
function appendScrollback(session: PtySession, data: string): void {
  session.scrollbackBuffer += data;
  session.scrollbackTotal += data.length;
  if (session.scrollbackBuffer.length > MAX_SCROLLBACK_SIZE * 1.25) {
    session.scrollbackBuffer = session.scrollbackBuffer.slice(-MAX_SCROLLBACK_SIZE);
  }
}

/**
 * Only classify launch failures in this window after spawn. The 'broken'
 * patterns (`spawn ... ENOENT`) aren't tied to the provider's command name,
 * so a running agent that later prints such an error from executing user
 * code must not retrigger the banner.
 */
const SPAWN_FAILURE_WINDOW_MS = 15_000;

/**
 * Cap on the per-session launch-output buffer. A genuinely failing launch
 * produces far less than this inside the failure window, so the signature is
 * always retained; the cap only bounds memory if a healthy chatty session
 * floods the first seconds.
 */
const LAUNCH_OUTPUT_CAP = 256 * 1024;

/**
 * Floor on how often a session's transcript is consulted for a quota
 * rejection. Output arrives many times a second; a refusal does not.
 */
const QUOTA_CHECK_INTERVAL_MS = 3000;

/**
 * Provider-agnostic "waiting for user input" patterns — generic prompt shapes
 * any terminal agent produces. Provider-specific TUI patterns (selection
 * menus, permission dialogs) live on each ProviderDefinition and are merged
 * in by detectAgentState.
 */
const GENERIC_WAITING_PATTERNS = [
  /\?\s*$/,                          // Ends with question mark
  /\(y\/n\)/i,                        // Yes/no prompt
  /\[Y\/n\]/i,                        // Yes/no prompt
  /Press Enter/i,                     // Press enter prompt
  /Do you want to/i,                  // Permission prompts
  /Do you trust/i,                    // Trust folder prompt
  /Would you like/i,                  // Permission prompts
  /Yes,\s*proceed/i,                  // Yes/No options
  /\d+\.\s*Yes/i,                     // Numbered Yes option
  // Conversational questions from the agent asking for feedback/confirmation
  /does this.{0,50}work for you\?/i,      // "Does this approach work for you?"
  /does this.{0,50}look right/i,          // "Does this look right?"
  /does that.{0,50}work/i,                // "Does that work for you?"
  /does that.{0,50}make sense/i,          // "Does that make sense?"
  /what do you think\?/i,                 // "What do you think?"
  /how does this look\?/i,                // "How does this look?"
  /is this.{0,30}(okay|ok|correct|right)\?/i, // "Is this okay?"
  /should I.{0,50}\?/i,                   // "Should I proceed?"
  /shall I.{0,50}\?/i,                    // "Shall I continue?"
  /let me know.{0,30}(if|when|what)/i,    // "Let me know if..."
  /any.{0,20}(feedback|thoughts|questions)\?/i, // "Any feedback?"
  /sound good\?/i,                        // "Sound good?"
  /ready to.{0,30}\?/i,                   // "Ready to proceed?"
  /want me to.{0,50}\?/i,                 // "Want me to continue?"
  /proceed with/i,                        // "Proceed with this approach?"
] as const;

/**
 * How to launch a command string under the user's shell: the executable to
 * spawn, how to wrap the command into argv, and the shell's syntax for
 * referencing an environment variable inside that command string. Single
 * source of truth for both regular agent sessions and login ptys.
 */
/** Merged generic + provider waiting patterns, computed once per provider id. */
const mergedWaitingPatterns = new Map<string, readonly RegExp[]>();

function getWaitingPatterns(provider: ProviderDefinition | null): readonly RegExp[] {
  if (!provider?.waitingPatterns?.length) return GENERIC_WAITING_PATTERNS;
  let merged = mergedWaitingPatterns.get(provider.id);
  if (!merged) {
    merged = [...GENERIC_WAITING_PATTERNS, ...provider.waitingPatterns];
    mergedWaitingPatterns.set(provider.id, merged);
  }
  return merged;
}

export class PtyManager extends EventEmitter {
  private sessions: Map<string, PtySession> = new Map();
  private readonly pendingKills: Map<string, PendingKill> = new Map();
  private socketPath: string;
  /** How long a signalled pty gets to exit before kill() escalates by force. */
  private readonly killGraceMs: number;

  constructor(opts?: { killGraceMs?: number }) {
    super();
    this.socketPath = getSocketPath();
    this.killGraceMs = opts?.killGraceMs ?? 3000;
  }

  private getShellInfo(): ShellInfo {
    // Get custom shell path from preferences (re-read each time to pick up changes)
    const customShellPath = getPreference('customShellPath') || '';
    console.log('Custom shell path from preferences:', customShellPath || '(not set)');
    const result = detectShell(customShellPath);
    console.log('Detected shell:', result);
    return result;
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  getDefaultShellInfo(): ShellInfo {
    return this.getShellInfo();
  }

  createSession(
    id: string,
    cwd: string,
    launchClaude: boolean = false,
    providerId: string = DEFAULT_PROVIDER_ID,
    /**
     * Initial pty size. Only the in-process resume-failure respawn passes it
     * (#164) — a renderer-driven spawn re-fits over pty:create, but a silent
     * replacement gets no round trip and would sit at 80x24 forever.
     */
    size?: { cols: number; rows: number },
  ): void {
    // One id, one pty. This used to overwrite the map entry and let the
    // displaced process run on: loud before the identity guard (its exit
    // deleted the replacement), silent after it (#164) — the incumbent's exit
    // is swallowed, its output dropped, and nothing is left holding a handle
    // to kill it. A refused create is recoverable; a Claude Code nobody can
    // reach is not. Callers that mean to replace a pty kill it first, and
    // kill() removes the entry synchronously, so the legitimate restart and
    // resume-failure respawn paths never see this.
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already has a running pty — kill it before creating another`);
    }

    // Validate cwd exists
    if (!fs.existsSync(cwd)) {
      console.error(`Working directory does not exist: ${cwd}`);
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    let shell: string;
    let args: string[] = [];
    let env = process.env as { [key: string]: string };
    const shellInfo = this.getShellInfo();

    console.log('Creating session with shell:', shellInfo.shell, 'args:', shellInfo.args, 'isWSL:', shellInfo.isWSL);

    // Validate shell exists
    if (!shellInfo.shell || !fs.existsSync(shellInfo.shell)) {
      const errorMsg = `Shell not found: ${shellInfo.shell || '(empty)'}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Track agent resume state for early-exit fallback (BDHLNDR-9).
    // resolveProvider degrades unknown ids (e.g. rows written by a newer app
    // version) to the default provider instead of failing the launch (#96).
    const provider = launchClaude ? resolveProvider(providerId, `session ${id}`) : null;
    let resumeAttempted = false;
    // Which account the pty is about to launch under (#165). Built from the
    // same resolution that produces CLAUDE_CONFIG_DIR, so it can't drift from
    // what the CLI actually receives.
    let accountBinding: { accountId: string | null; configDir: string } | null = null;
    let transcriptStaged: TranscriptCarryResult | null = null;

    if (provider) {
      const agentSpawn = this.buildAgentSpawn(provider, id, cwd, shellInfo);
      shell = agentSpawn.shell;
      args = agentSpawn.args;
      env = agentSpawn.env;
      resumeAttempted = agentSpawn.resumeAttempted;
      accountBinding = agentSpawn.accountBinding;
      transcriptStaged = agentSpawn.transcriptStaged;
    } else {
      shell = shellInfo.shell;
      args = shellInfo.args;
    }

    const cols = size?.cols ?? 80;
    const rows = size?.rows ?? 24;

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: shellInfo.isWSL && !launchClaude ? undefined : cwd,
      env: env,
      // Windows ConPTY options to reduce race conditions (error 299)
      ...(process.platform === 'win32' ? {
        useConptyDll: true,  // Use bundled ConPTY DLL from Windows Terminal (often newer/more stable)
        conptyInheritCursor: false,  // Don't inherit cursor - cleaner startup
      } : {}),
    });

    // Stamped once the process exists, so the BDHLNDR-9 resume-failure window
    // measures the CLI's life rather than our own account resolution and
    // transcript staging.
    const spawnedAt = Date.now();
    const liveAccount: LiveAccountBinding | null = accountBinding
      ? { ...accountBinding, spawnedAt }
      : null;

    ptyProcess.onData((data) => {
      const session = this.sessions.get(id);
      // Guard: reject data from a PTY that is being torn down, or from one this
      // id has already moved on from (#164) — a slow-dying Claude would
      // otherwise interleave its farewell output into its replacement's stream.
      if (!session || session.killing || session.pty !== ptyProcess) return;

      // Filter out Windows ConPTY error messages
      // Win32 error 299 (ERROR_PARTIAL_COPY) is a race condition when reading from
      // a terminating process. Using useConptyDll should reduce these occurrences.
      // We still filter the error message text if it appears.
      let filteredData = data;
      if (process.platform === 'win32') {
        // Remove "windows pid XXXXX, Win32 error NNN" error messages
        filteredData = filteredData.replace(/windows pid \d+, Win32 error \d+/gi, '');
        // If the entire chunk was just the error message, skip emitting
        if (filteredData.trim() === '') {
          return;
        }
      }

      // Append to scrollback buffer (replayed to remote viewers on attach).
      if (session) appendScrollback(session, filteredData);

      this.emit('data', { id, data: filteredData });

      if (provider) {
        this.recordLaunchOutput(session, filteredData);
        this.checkSpawnFailure(id);
        this.detectAgentState(id, data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      // Always release a kill() that is waiting on THIS process, even when the
      // id has since been re-used: the caller asked about this pty, not about
      // the id. Must precede the superseded check, or a kill whose id was
      // re-bound never resolves and the renderer awaits it forever.
      this.settleKill(id, ptyProcess);

      if (this.isSupersededPty(id, ptyProcess)) {
        // A replacement is already running under this id (#164). This exit
        // belongs to a pty nobody owns any more — reporting it would delete a
        // live session or, through the resume-failure fallback below, destroy
        // its conversation.
        log.info(`[PTY] Ignoring late exit (code ${exitCode}) from a superseded pty for session ${id}`);
        return;
      }

      // Resume-failure fallback (BDHLNDR-9): if we launched the agent with its
      // resume flag and it exited non-zero within the failure window, treat
      // that as a dead session and transparently respawn with a fresh UUID.
      // The renderer never sees an 'exit' event for this path — it just sees
      // new output from the replacement pty.
      //
      // Gated on the launch-time staging result (#164). Clearing the stored
      // conversation id is the one operation in this file that destroys user
      // history, and a non-zero exit inside 5s is weak evidence for it: a bad
      // key from the #99 vault, a broken MCP entry in the account's
      // settings.json, ENOSPC or a shell rc that fails fast all land here with
      // the transcript sitting intact on disk. When buildAgentSpawn saw the
      // file in the dir it launched under ('present'/'carried'), the resume was
      // not doomed by a missing conversation and the id stays. Only 'missing'
      // — searched every known config dir, found nothing — earns the clear,
      // and a provider with no account support (staging never ran, so null)
      // keeps the original unconditional behavior.
      const session = this.sessions.get(id);
      const resumeFailedEarly = !!session?.provider
        && session.resumeAttempted
        && exitCode !== 0
        && Date.now() - session.spawnedAt < RESUME_FAILURE_WINDOW_MS;
      const transcriptOnDisk = session?.transcriptStaged === 'present'
        || session?.transcriptStaged === 'carried';

      if (resumeFailedEarly && transcriptOnDisk && session?.provider) {
        log.warn(
          `[PTY] ${session.provider.name} exited ${exitCode} for session ${id} within the resume ` +
          `window, but its transcript is staged in the config dir it launched under — keeping the ` +
          `conversation id and surfacing the exit instead of starting over.`
        );
      } else if (resumeFailedEarly && session) {
        log.warn(
          `[PTY] ${session.provider!.name} resume failed for session ${id} (exitCode=${exitCode}, ` +
          `age=${Date.now() - session.spawnedAt}ms). Clearing stored session ID ` +
          `and retrying with a fresh agent session.`
        );
        try {
          clearStoredClaudeSessionId(id);
        } catch (e) {
          log.error(`[PTY] Failed to clear claude_session_id for ${id}:`, e);
        }
        // #164: carry the size forward. createSession would otherwise spawn at
        // 80x24 while deliberately hiding the exit from the renderer, so no
        // pty:create round trip and no re-fit ever happens — the TUI renders at
        // a quarter of the window.
        const replacementSize = { cols: session.lastCols, rows: session.lastRows };
        // Remove the dead entry so createSession can re-insert a fresh one.
        this.disposeSessionTimers(session);
        this.sessions.delete(id);
        try {
          this.createSession(id, cwd, true, providerId, replacementSize);
          return; // Successful retry — suppress the exit emission.
        } catch (e) {
          log.error(`[PTY] Resume-failure retry spawn failed for ${id}:`, e);
          // Fall through to emit the original exit so the UI recovers.
        }
      }

      if (session) this.disposeSessionTimers(session);
      this.emit('exit', { id, exitCode });
      this.sessions.delete(id);
      // A stopped session stops claiming a live account (#165).
      this.emit('liveAccount', { id, binding: null });
    });

    this.sessions.set(id, {
      id,
      pty: ptyProcess,
      cwd,
      provider,
      shellInfo,
      lastState: 'idle',
      outputBuffer: '',
      scrollbackBuffer: '',
      scrollbackTotal: 0,
      idleTimeout: null,
      workingDebounce: null,
      recentOutputBytes: 0,
      lastOutputTime: 0,
      resumeAttempted,
      spawnedAt,
      transcriptStaged,
      liveAccount,
      lastCols: cols,
      lastRows: rows,
      killing: false,
      spawnFailureNotified: false,
      launchOutput: '',
      // Regular sessions spawn only after the renderer explicitly called
      // pty:create, so listeners are already attached — no deferral needed.
      usageLimitReported: false,
      quotaCheckedAt: 0,
      deferEmission: false,
    });

    // Publish the account this pty is running under (#165). One emission point
    // covers first launch, the renderer's restart, the silent resume-failure
    // respawn, and every headless spawn (relay, HTTP API).
    this.emit('liveAccount', { id, binding: liveAccount });
  }

  /**
   * Has `id` been re-bound to a different pty than the one whose callback is
   * running (#164)?
   *
   * A pty's onData/onExit close over `id` and re-look the session up when they
   * fire, so a Claude Code that takes longer than the restart to die reports its
   * death against its own replacement — deleting a live session, or wiping the
   * replacement's conversation UUID through the resume-failure fallback.
   *
   * Note the shape: "bail only if the map holds a DIFFERENT pty", never "bail
   * unless the map holds this pty". kill() removes the entry BEFORE signalling
   * the process, so the strict form would suppress the exit event for every
   * deliberate kill and break cancelLoginFlow, the install modal, the ws-server
   * fan-out and the relay tunnel.
   *
   * Instance identity rather than a counter: spawnedAt (which the relay already
   * treats as the pty's epoch, session-tunnel-deps.ts) is Date.now() and so
   * collides for two spawns in the same millisecond, and a new counter would be
   * a second, contradictable notion of the same fact. Object identity cannot
   * collide and costs nothing.
   */
  private isSupersededPty(id: string, ptyProcess: pty.IPty): boolean {
    const current = this.sessions.get(id);
    return current !== undefined && current.pty !== ptyProcess;
  }

  /**
   * Free a session's pending timers. Both delete sites used to drop the entry
   * while its idle/working timers were still armed (#164); those timers re-look
   * the session up by id when they fire, so they outlived their own session and
   * drove state changes — and notifications — for whatever took its place.
   */
  private disposeSessionTimers(session: PtySession): void {
    if (session.idleTimeout) {
      clearTimeout(session.idleTimeout);
      session.idleTimeout = null;
    }
    if (session.workingDebounce) {
      clearTimeout(session.workingDebounce);
      session.workingDebounce = null;
    }
  }

  /** Live account bindings for every running agent pty, keyed by session id (#165). */
  getLiveAccounts(): LiveAccountBindings {
    const out: LiveAccountBindings = {};
    for (const [id, session] of this.sessions) {
      if (session.liveAccount) out[id] = session.liveAccount;
    }
    return out;
  }

  /**
   * Resolve everything needed to spawn an agent session under the user's
   * shell: conversation UUID + resume mode (BDHLNDR-9), account config dir
   * (BDHLNDR-31), the provider's command/env, and the shell-appropriate argv
   * wrapping.
   */
  private buildAgentSpawn(
    provider: ProviderDefinition,
    id: string,
    cwd: string,
    shellInfo: ShellInfo
  ): {
    shell: string;
    args: string[];
    env: { [key: string]: string };
    resumeAttempted: boolean;
    /** What the pty will actually run under (#165); null for providers without accounts. */
    accountBinding: { accountId: string | null; configDir: string } | null;
    /** Outcome of the launch-time transcript staging (#164); null when it didn't run. */
    transcriptStaged: TranscriptCarryResult | null;
  } {
    let agentSessionId: string | null = null;
    let agentSessionMode: AgentSessionMode | null = null;

    if (provider.capabilities.resume) {
      // Resolve the agent conversation UUID + mode (BDHLNDR-9).
      // If we have a stored ID, we're restarting and should resume. Otherwise
      // generate a fresh UUID, pass it via the provider's new-session flag,
      // and persist it so the NEXT launch can resume.
      const storedAgentSessionId = getStoredClaudeSessionId(id);
      if (storedAgentSessionId && !isPathSafeConversationId(storedAgentSessionId)) {
        // The stored id becomes two things at launch: a path segment, and a
        // word on the command line the shell parses (see agentCmd below, which
        // inlines it unescaped because a UUID cannot contain a metacharacter).
        // Nothing this app writes can fail the check — but group-import-export
        // inserts claude_session_id straight from a shared group file, so the
        // value is not exclusively ours. Refusing it at the boundary where it
        // becomes dangerous makes the property hold regardless of the writer;
        // the conversation is then unreachable by id, which a corrupt id
        // already was.
        log.error(
          `[PTY] Refusing to resume session ${id}: stored conversation id has an unexpected ` +
          `format. Starting a fresh conversation.`
        );
        clearStoredClaudeSessionId(id);
        agentSessionId = generateAgentSessionId();
        agentSessionMode = 'new';
        storeClaudeSessionId(id, agentSessionId);
      } else if (storedAgentSessionId) {
        agentSessionId = storedAgentSessionId;
        agentSessionMode = 'resume';
      } else {
        agentSessionId = generateAgentSessionId();
        agentSessionMode = 'new';
        storeClaudeSessionId(id, agentSessionId);
      }
    }

    // Resolve which account this session should launch under (BDHLNDR-31).
    // Returns null when no accounts are registered, preserving legacy ~/.claude behavior.
    const account = provider.capabilities.accounts ? resolveAccountForSession(id) : null;
    if (account) {
      touchAccount(account.id);
    }

    // Carry the conversation into the account we are about to launch under (#164).
    // Late, not at switch time: a live Claude keeps appending to the old account's
    // tree until its pty dies, so a copy taken when the user clicked is already
    // stale by the time we spawn. Doing it here means the newest bytes are in place
    // the instant before the CLI reads them.
    //
    // A 'missing' result deliberately does NOT downgrade resume→new: a session
    // that was opened but never messaged legitimately has no .jsonl, and the
    // BDHLNDR-9 resume-failure fallback is the recovery path for the rest.
    let transcriptStaged: TranscriptCarryResult | null = null;
    if (agentSessionMode === 'resume' && agentSessionId && provider.capabilities.accounts) {
      try {
        const effectiveDir = account?.configDir ?? legacyClaudeConfigDir();
        // Deduplicated: the legacy dir is also a candidate in its own right, and
        // a scan is a readdir plus a stat per project slug on the main thread.
        const candidates = [...new Set([
          legacyClaudeConfigDir(),
          ...getAllAccounts().map(a => a.configDir),
        ])];
        transcriptStaged = ensureTranscriptInConfigDir(agentSessionId, effectiveDir, candidates);
      } catch (err) {
        // A filesystem or DB problem must never block a launch — the worst case
        // is one doomed --resume that the fallback absorbs.
        log.warn(`[PTY] Could not stage conversation ${agentSessionId} for session ${id}:`, err);
      }
    }

    const launch = provider.buildCommand({
      sessionId: id,
      projectDir: cwd,
      socketPath: this.socketPath,
      agentSession: agentSessionId && agentSessionMode
        ? { id: agentSessionId, mode: agentSessionMode }
        : undefined,
      configDir: account?.configDir,
    });

    // Suffix appended to every shell's agent command. UUIDs are alphanumeric
    // + hyphens, so they are safe to inline without escaping.
    // e.g. ' --resume 7a3f...' or ' --session-id 7a3f...'
    const sessionFlag = launch.args.length > 0
      ? ' ' + launch.args.join(' ')
      : '';

    const agentCmd = `${launch.command}${sessionFlag}`;
    // vaultEnvFor is empty unless the user explicitly opted this provider
    // into API-key auth (#99) — CLI login/subscription stays the default.
    const vaultEnv = vaultEnvFor(provider.id);
    if (Object.keys(vaultEnv).length > 0) {
      // Visibility that key auth is active; values scrubbed via redactEnv.
      log.info(`[PTY] API-key auth enabled for '${provider.id}':`, redactEnv(vaultEnv));
    }
    const processEnv = { ...process.env, ...launch.env, ...vaultEnv } as { [key: string]: string };

    // The agent command interpolates no env values — everything the CLI needs
    // travels in processEnv — so cmd.exe can host it unchanged (#106).
    const shellLaunch = getShellLaunch(shellInfo, { needsEnvRef: false });

    return {
      shell: shellLaunch.shell,
      args: shellLaunch.wrap(agentCmd),
      env: processEnv,
      resumeAttempted: agentSessionMode === 'resume',
      // "Running under ~/.claude" is meaningless for a provider that never
      // reads CLAUDE_CONFIG_DIR, so those publish nothing at all (#165).
      accountBinding: provider.capabilities.accounts
        ? { accountId: account?.id ?? null, configDir: account?.configDir ?? legacyClaudeConfigDir() }
        : null,
      transcriptStaged,
    };
  }

  /**
   * Accumulate output into the launch-failure buffer while it can still
   * matter; free it the moment it can't (hint already fired, or the failure
   * window has passed).
   */
  private recordLaunchOutput(session: PtySession, data: string): void {
    if (session.spawnFailureNotified) return;
    if (Date.now() - session.spawnedAt > SPAWN_FAILURE_WINDOW_MS) {
      session.launchOutput = '';
      return;
    }
    if (session.launchOutput.length < LAUNCH_OUTPUT_CAP) {
      session.launchOutput = (session.launchOutput + data).slice(0, LAUNCH_OUTPUT_CAP);
    }
  }

  /**
   * Classify early session output as a CLI launch failure (missing from
   * PATH, or installed-but-broken like codex's `spawn ... ENOENT`) and emit
   * a one-shot 'providerHint' event so the renderer can show a friendly
   * install banner. Checks the accumulated launch buffer rather than the
   * chunk, so an error split across pty reads still matches.
   */
  private checkSpawnFailure(id: string): void {
    const session = this.sessions.get(id);
    if (!session?.provider || session.spawnFailureNotified) return;
    if (Date.now() - session.spawnedAt > SPAWN_FAILURE_WINDOW_MS) return;

    const kind = classifySpawnFailure(session.provider.command, session.launchOutput);
    if (!kind) return;

    session.spawnFailureNotified = true;
    session.launchOutput = '';
    const { setup } = session.provider;
    log.warn(`[PTY] ${session.provider.name} launch failure (${kind}) detected for session ${id}`);
    const hint: ProviderInstallHint = {
      sessionId: id,
      providerId: session.provider.id,
      providerName: session.provider.name,
      command: session.provider.command,
      kind,
      installHint: setup.installHint,
      installCommand: setup.installCommand ?? null,
      docsUrl: setup.docsUrl,
    };
    this.emit('providerHint', hint);
  }

  /**
   * Spawn a pty running a provider's install command so the user can watch it
   * instead of copy-pasting into their own terminal (follow-up to #97's
   * install hints). Runs through the user's shell like sessions do, defers
   * emission until the renderer primes it (BDHLNDR-33), and exits when the
   * install command does — the pty's exit code is the install's.
   */
  createInstallSession(id: string, installCommand: string): void {
    const shellInfo = this.getShellInfo();
    if (!shellInfo.shell || !fs.existsSync(shellInfo.shell)) {
      throw new Error(`Shell not found: ${shellInfo.shell || '(empty)'}`);
    }

    const cwd = os.homedir();
    // Static registry string (never user input) with no env interpolation.
    const shellLaunch = getShellLaunch(shellInfo, { needsEnvRef: false });

    log.info(`[PTY] Starting install pty ${id}: ${installCommand}`);

    const ptyProcess = pty.spawn(shellLaunch.shell, shellLaunch.wrap(installCommand), {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: shellInfo.isWSL ? undefined : cwd,
      env: process.env as { [key: string]: string },
      ...(process.platform === 'win32' ? {
        useConptyDll: true,
        conptyInheritCursor: false,
      } : {}),
    });

    ptyProcess.onData((data) => {
      const session = this.sessions.get(id);
      // Install ptys reuse a deterministic id (`__install-<providerId>`) and
      // startProviderInstall kills then immediately re-creates, so a hung
      // installer could dump its scrollback into the new stream (#164).
      if (!session || session.killing || session.pty !== ptyProcess) return;

      let filteredData = data;
      if (process.platform === 'win32') {
        filteredData = filteredData.replace(/windows pid \d+, Win32 error \d+/gi, '');
        if (filteredData.trim() === '') return;
      }

      appendScrollback(session, filteredData);

      if (session.deferEmission) return;

      this.emit('data', { id, data: filteredData });
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.settleKill(id, ptyProcess);
      // A hung installer still alive at the 3s force path would otherwise close
      // the modal with the wrong exit code and orphan its replacement (#164).
      if (this.isSupersededPty(id, ptyProcess)) return;

      // Flush pre-prime output so a fast failure isn't a blank box.
      const session = this.sessions.get(id);
      if (session?.deferEmission && session.scrollbackBuffer) {
        this.emit('data', { id, data: session.scrollbackBuffer });
        session.deferEmission = false;
      }
      this.emit('exit', { id, exitCode });
      this.sessions.delete(id);
    });

    this.sessions.set(id, {
      id,
      pty: ptyProcess,
      cwd,
      // No provider: install ptys need no agent state detection or hints.
      provider: null,
      shellInfo,
      lastState: 'idle',
      outputBuffer: '',
      scrollbackBuffer: '',
      scrollbackTotal: 0,
      idleTimeout: null,
      workingDebounce: null,
      recentOutputBytes: 0,
      lastOutputTime: 0,
      resumeAttempted: false,
      // Neither pty resumes a conversation, so nothing was staged for one.
      transcriptStaged: null,
      spawnedAt: Date.now(),
      // Not a DB session — an install pty bills no account (#165).
      liveAccount: null,
      lastCols: 80,
      lastRows: 24,
      killing: false,
      spawnFailureNotified: false,
      launchOutput: '',
      // Spawned before the renderer's Terminal mounts — same race as the
      // login pty (BDHLNDR-33).
      usageLimitReported: false,
      quotaCheckedAt: 0,
      deferEmission: true,
    });
  }

  /**
   * Spawn a pty running `claude` under an isolated CLAUDE_CONFIG_DIR for the
   * interactive add-account login flow (BDHLNDR-31). Keyed by an arbitrary pty
   * id that's not tied to a DB session — reuses the standard pty events so the
   * renderer Terminal can attach unchanged.
   *
   * Skips session-UUID management and state detection; this pty exists only
   * long enough for the user to complete `/login` via browser OAuth, after
   * which the caller tears it down.
   */
  createLoginSession(id: string, configDir: string): void {
    const shellInfo = this.getShellInfo();
    if (!shellInfo.shell || !fs.existsSync(shellInfo.shell)) {
      throw new Error(`Shell not found: ${shellInfo.shell || '(empty)'}`);
    }

    const cwd = os.homedir();
    const processEnv: { [key: string]: string } = {
      ...(process.env as { [key: string]: string }),
      [CLAUDE_CONFIG_DIR_ENV]: configDir,
    };
    const agentCmd = claudeProvider.command;

    // The login pty just runs `claude` — no env-ref interpolation — so it
    // keeps the user's cmd.exe shell rather than rerouting to PowerShell (#106).
    const shellLaunch = getShellLaunch(shellInfo, { needsEnvRef: false });
    const shell = shellLaunch.shell;
    const args = shellLaunch.wrap(agentCmd);

    log.info(`[PTY] Starting login pty ${id} with CLAUDE_CONFIG_DIR=${configDir}`);

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: shellInfo.isWSL ? undefined : cwd,
      env: processEnv,
      ...(process.platform === 'win32' ? {
        useConptyDll: true,
        conptyInheritCursor: false,
      } : {}),
    });

    ptyProcess.onData((data) => {
      const session = this.sessions.get(id);
      // Login ids are `__login-<accountId>` and every flow today mints a fresh
      // accountId, so colliding on one needs a re-login-to-an-existing-account
      // flow that does not exist yet — this guard is what keeps adding one
      // safe (#164). account-auth's exit listener filters on event.id alone
      // and inherits whatever discipline this emit has.
      if (!session || session.killing || session.pty !== ptyProcess) return;

      let filteredData = data;
      if (process.platform === 'win32') {
        filteredData = filteredData.replace(/windows pid \d+, Win32 error \d+/gi, '');
        if (filteredData.trim() === '') return;
      }

      appendScrollback(session, filteredData);

      // Hold emission until the renderer primes this pty (BDHLNDR-33). The
      // scrollback is accumulated above regardless, so nothing is lost.
      if (session.deferEmission) return;

      this.emit('data', { id, data: filteredData });
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.settleKill(id, ptyProcess);
      if (this.isSupersededPty(id, ptyProcess)) return;

      // If the pty exited before being primed, flush whatever it managed to
      // print so the renderer can show the error instead of a blank box.
      const session = this.sessions.get(id);
      if (session?.deferEmission && session.scrollbackBuffer) {
        this.emit('data', { id, data: session.scrollbackBuffer });
        session.deferEmission = false;
      }
      this.emit('exit', { id, exitCode });
      this.sessions.delete(id);
    });

    this.sessions.set(id, {
      id,
      pty: ptyProcess,
      cwd,
      provider: claudeProvider,
      shellInfo,
      lastState: 'idle',
      outputBuffer: '',
      scrollbackBuffer: '',
      scrollbackTotal: 0,
      idleTimeout: null,
      workingDebounce: null,
      recentOutputBytes: 0,
      lastOutputTime: 0,
      resumeAttempted: false,
      // Neither pty resumes a conversation, so nothing was staged for one.
      transcriptStaged: null,
      spawnedAt: Date.now(),
      // The login pty runs under a config dir that has no credentials yet —
      // it isn't a DB session and bills nothing (#165).
      liveAccount: null,
      lastCols: 80,
      lastRows: 24,
      killing: false,
      spawnFailureNotified: false,
      launchOutput: '',
      // Login ptys defer event emission until the renderer attaches its
      // listener and calls primePty — avoids losing claude's startup banner
      // in the IPC-round-trip + React-render gap (BDHLNDR-33).
      usageLimitReported: false,
      quotaCheckedAt: 0,
      deferEmission: true,
    });
  }

  /**
   * Flush a login pty's accumulated scrollback to the renderer as a single
   * 'data' event, then unlock live emission (BDHLNDR-33). The two operations
   * happen in the same synchronous tick so no live data sneaks in between —
   * preserving strict ordering even on the renderer side. Idempotent: after
   * the first call, subsequent calls are no-ops.
   */
  primePty(id: string): void {
    const session = this.sessions.get(id);
    if (!session || !session.deferEmission) return;
    if (session.scrollbackBuffer) {
      this.emit('data', { id, data: session.scrollbackBuffer });
    }
    session.deferEmission = false;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session && !session.killing) {
      session.pty.write(data);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.killing) return;
    // Skip no-op resizes to avoid unnecessary ConPTY churn on Windows
    if (session.lastCols === cols && session.lastRows === rows) return;
    session.lastCols = cols;
    session.lastRows = rows;
    session.pty.resize(cols, rows);
    // Notify listeners (e.g. the relay agent, which forwards the new size to
    // remote viewers so they re-render at the current PTY dimensions). Dynamic
    // sizing: whichever viewer is active drives the size, and everyone else
    // follows via this event.
    this.emit('resize', { id, cols, rows });
  }

  /**
   * Terminate a session's pty and resolve once the process is really gone (#164).
   *
   * This used to resolve off a 3s timer with no connection to the exit at all, so
   * "await the kill, then respawn" bought a hard three-second stall and still did
   * not order the old death before the new spawn. It now settles from the pty's
   * own onExit, with the force path as the bound.
   *
   * Calls coalesce by id, and that is load-bearing: the renderer's restart kills
   * from BOTH the effect cleanup and the restart effect, in an order React does
   * not promise. The second caller must wait on the first teardown rather than
   * see an empty map and conclude the process is gone.
   */
  async kill(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      // No live pty: either a teardown is still draining for this id (join it)
      // or there was never anything to kill.
      return this.pendingKills.get(id)?.promise ?? Promise.resolve();
    }

    // A live pty under an id that still has a pending kill means the previous
    // process outlived its own teardown and something respawned over it (the
    // HTTP API's stop-then-start, whose getSession check passes the instant
    // kill() empties the map). Its waiter can never be settled by an exit we
    // will still be listening for, so release it — but keep its force timer
    // armed. That timer is the only escalation the dying process has left, and
    // on Windows it is the only taskkill /F /T anyone will ever issue for it.
    const stale = this.pendingKills.get(id);
    if (stale) {
      log.warn(
        `[PTY] Session ${id} is being killed again while an earlier teardown has not finished; ` +
        `releasing the earlier waiter and leaving its force timer to reap the old process.`
      );
      stale.settle({ keepReaper: true });
    }

    // Mark as killing FIRST — prevents write/resize/onData from touching
    // the native PTY handle during teardown.
    session.killing = true;

    this.disposeSessionTimers(session);

    const pid = session.pty.pid;
    const ptyProcess = session.pty;

    // Remove from map BEFORE calling pty.kill() so concurrent IPC calls
    // (write, resize) get a null lookup and bail out instead of hitting
    // a freed native handle.
    this.sessions.delete(id);
    // Clear the header the instant teardown starts rather than one process
    // death later (#165). The exit emits null again; the reducer is idempotent.
    this.emit('liveAccount', { id, binding: null });

    let settled = false;
    let resolvePromise: () => void = () => {};
    const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });

    const entry: PendingKill = {
      pty: ptyProcess,
      promise,
      timer: null,
      settle: (opts) => {
        if (settled) return;
        settled = true;
        if (entry.timer && !opts?.keepReaper) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        if (this.pendingKills.get(id) === entry) {
          this.pendingKills.delete(id);
        }
        resolvePromise();
      },
    };
    this.pendingKills.set(id, entry);

    // Arm the force path BEFORE signalling: a pty that exits synchronously
    // inside kill() would otherwise settle first and leave this timer armed on
    // an already-settled entry, warning about a process that died on time.
    // This is the bound on how long a pty that ignores the signal can hold up
    // its caller, not the mechanism that normally settles.
    if (process.platform === 'win32' && pid) {
      entry.timer = setTimeout(() => {
        log.warn(`[PTY] Force-killing session ${id} (pid ${pid}) after ${this.killGraceMs}ms timeout`);
        try {
          execFile('taskkill', ['/F', '/T', '/PID', String(pid)], (err) => {
            if (err) {
              log.error(`[PTY] taskkill failed for pid ${pid}:`, err);
            }
            entry.settle();
          });
        } catch (err) {
          log.error(`[PTY] Failed to spawn taskkill for pid ${pid}:`, err);
          entry.settle();
        }
      }, this.killGraceMs);
    } else {
      entry.timer = setTimeout(() => {
        // node-pty's UnixTerminal.kill() sends SIGHUP and swallows the result,
        // so a CLI that traps it — or a wrapper shell whose child ignores it —
        // is still running here. Settling without escalating would resolve
        // `await kill()` on a live process and hand the restart the same
        // guess-based ordering #164 removed, except now the survivor is muted
        // by the identity guard and there is no exit to notice it by.
        log.warn(`[PTY] Session ${id} (pid ${pid}) ignored SIGHUP for ${this.killGraceMs}ms; escalating to SIGKILL`);
        // Through the pty handle rather than process.kill, so the signal can
        // only ever reach a process this manager spawned.
        try {
          ptyProcess.kill('SIGKILL');
        } catch (err) {
          log.error(`[PTY] SIGKILL failed for session ${id} (pid ${pid}):`, err);
        }
        entry.settle();
      }, this.killGraceMs);
    }

    // Send the graceful kill signal. The onExit handler registered at spawn
    // calls settleKill, which resolves the promise returned here.
    session.pty.kill();

    return promise;
  }

  /** Release a kill() waiting on this exact pty. No-op for any other pty (#164). */
  private settleKill(id: string, ptyProcess: pty.IPty): void {
    const pending = this.pendingKills.get(id);
    if (pending?.pty !== ptyProcess) return;
    pending.settle();
  }

  async killAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.kill(id)));
  }

  getSession(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  /** Current terminal dimensions of a session (for remote viewers to match). */
  getSize(id: string): { cols: number; rows: number } {
    const session = this.sessions.get(id);
    return { cols: session?.lastCols ?? 80, rows: session?.lastRows ?? 24 };
  }

  /**
   * Get the scrollback buffer for a session
   */
  getBuffer(id: string): string {
    const session = this.sessions.get(id);
    return session?.scrollbackBuffer || '';
  }

  /**
   * Rendered-text history for remote viewers. Replays the raw scrollback through
   * a headless terminal at the session's CURRENT width and serializes the result
   * to resolved text (colors kept, but no cursor-addressing). Unlike the raw
   * bytes, this can be reflowed to a different width (e.g. a phone) WITHOUT
   * garbling — Claude's absolute cursor moves have already been applied here.
   * Falls back to the raw buffer if serialization isn't available.
   */
  async getSerializedBuffer(id: string): Promise<string> {
    const session = this.sessions.get(id);
    const raw = session?.scrollbackBuffer;
    if (!session || !raw) return '';
    return this.serialize(session, raw);
  }

  /**
   * A point in this session's output stream that stays meaningful later.
   *
   * Returned as a count of characters ever produced, not an index into the
   * scrollback: the buffer is a sliding window, so an index into it means
   * something different after every trim. Null when the session isn't running,
   * which the caller must treat as "no mark" rather than as position zero —
   * zero would replay the whole buffer.
   */
  scrollbackMark(id: string): number | null {
    const session = this.sessions.get(id);
    return session ? session.scrollbackTotal : null;
  }

  /**
   * Rendered-text history from `mark` onward — what a shared session has
   * produced since someone was let into it (#169).
   *
   * A guest is never sent the whole scrollback: replaying it would hand over
   * everything typed before the decision to share was made. But sending them
   * nothing on every attach means leaving the session and coming back wipes
   * what they had already watched, so the window between the mark and now is
   * exactly what they are entitled to and exactly what they lose otherwise.
   *
   * If the cap has already evicted the mark, this returns everything still
   * held — which is a subset of what they were entitled to, never a superset.
   */
  async getSerializedBufferSince(id: string, mark: number): Promise<string> {
    const session = this.sessions.get(id);
    if (!session?.scrollbackBuffer) return '';
    const evicted = session.scrollbackTotal - session.scrollbackBuffer.length;
    const start = Math.min(Math.max(0, mark - evicted), session.scrollbackBuffer.length);
    const raw = session.scrollbackBuffer.slice(start);
    if (!raw) return '';
    return this.serialize(session, raw);
  }

  /**
   * Render raw PTY bytes to resolved text through a headless terminal at the
   * session's CURRENT width. Unlike the raw bytes this can be reflowed to a
   * different width (e.g. a phone) WITHOUT garbling — the absolute cursor
   * moves have already been applied here. Falls back to the raw bytes if
   * serialization isn't available.
   */
  private async serialize(session: PtySession, raw: string): Promise<string> {
    try {
      const term = new HeadlessTerminal({
        cols: session.lastCols || 80,
        rows: session.lastRows || 24,
        scrollback: 20000,
        allowProposedApi: true,
      });
      const serializer = new SerializeAddon();
      term.loadAddon(serializer);
      await new Promise<void>((resolve) => term.write(raw, () => resolve()));
      const text = serializer.serialize({ scrollback: 20000 });
      term.dispose();
      return text;
    } catch (err) {
      console.warn('[PtyManager] serialize failed, falling back to raw:', err);
      return raw;
    }
  }

  /**
   * Arm the working→idle timeout for a session: after 2s without further
   * substantial output the session is marked idle. No-op when a timeout is
   * already armed or the session is gone.
   */
  private scheduleIdleTimeout(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.idleTimeout) return;
    session.idleTimeout = setTimeout(() => {
      // Compare against the captured session, not a fresh lookup (#164): an
      // id can be re-bound to a replacement pty while this timer is armed, and
      // the old session's timer must not drive the new session's state.
      if (this.sessions.get(id) !== session) return;
      if (session.lastState === 'working') {
        session.lastState = 'idle';
        session.recentOutputBytes = 0;
        session.idleTimeout = null;
        this.emit('stateChange', {
          sessionId: id,
          state: 'idle',
          event: 'idle_timeout',
          timestamp: Math.floor(Date.now() / 1000),
        });
      }
    }, 2000);
  }

  /** Immediately mark a session as waiting for user input. */
  private transitionToWaiting(id: string, session: PtySession, now: number): void {
    if (session.lastState === 'waiting') return;
    if (session.workingDebounce) {
      clearTimeout(session.workingDebounce);
      session.workingDebounce = null;
    }
    session.lastState = 'waiting';
    this.emit('stateChange', {
      sessionId: id,
      state: 'waiting',
      event: 'prompt_detected',
      timestamp: Math.floor(now / 1000),
    });
  }

  /**
   * Debounce a transition to working behind 300ms of sustained output
   * (200+ bytes) to avoid flickering.
   */
  private scheduleWorkingTransition(id: string, session: PtySession): void {
    if (session.lastState === 'working') return;
    if (session.recentOutputBytes <= 200 || session.workingDebounce) return;
    session.workingDebounce = setTimeout(() => {
      // Same re-binding hazard as scheduleIdleTimeout (#164).
      if (this.sessions.get(id) !== session) return;
      if (session.recentOutputBytes > 200) {
        session.lastState = 'working';
        session.workingDebounce = null;
        this.emit('stateChange', {
          sessionId: id,
          state: 'working',
          event: 'sustained_output',
          timestamp: Math.floor(Date.now() / 1000),
        });
        // Set idle timeout immediately after transitioning to working
        this.scheduleIdleTimeout(id);
      }
    }, 300); // Wait 300ms of sustained output
  }

  /**
   * Report a quota rejection once per pty.
   *
   * Output is the trigger, never the evidence. Terminal output cannot separate
   * a CLI announcing a limit from a CLI rendering a conversation about one, so
   * new output only prompts a look at the transcript, where the agent records
   * the rejection as a structured entry with an exact reset time.
   *
   * What is emitted is deliberately thin — the account this pty is BILLING
   * (its live binding, not the database assignment, which may already point
   * elsewhere) plus the reset. Deciding where the work goes belongs to
   * account-failover, which can see every account; this sees one terminal.
   */
  private checkUsageLimit(id: string, session: PtySession): void {
    if (session.usageLimitReported) return;
    if (!session.provider?.capabilities.accounts) return;

    const now = Date.now();
    if (now - session.quotaCheckedAt < QUOTA_CHECK_INTERVAL_MS) return;
    session.quotaCheckedAt = now;

    const conversationId = getStoredClaudeSessionId(id);
    const configDir = session.liveAccount?.configDir;
    if (!conversationId || !configDir) return;

    // Only a rejection this pty could have caused. A transcript is append-only
    // and replayed on resume, so an older entry is history, not news.
    const hit = readQuotaLimit(configDir, conversationId, new Date(session.spawnedAt));
    if (!hit) return;

    session.usageLimitReported = true;
    log.warn(
      `[Accounts] Session ${id} was refused by quota on account ` +
      `${session.liveAccount?.accountId ?? 'legacy ~/.claude'} ` +
      `(${hit.rateLimitType ?? 'unknown window'}, resets ${hit.resetAt.toISOString()})`
    );
    this.emit('usageLimit', {
      id,
      accountId: session.liveAccount?.accountId ?? null,
      resetAt: hit.resetAt,
      rateLimitType: hit.rateLimitType,
    });
  }

  private detectAgentState(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    const now = Date.now();

    // Safety: ensure working state always has an idle timeout
    // This catches cases where filtered events come in but timeout was never set
    if (session.lastState === 'working') {
      this.scheduleIdleTimeout(id);
    }

    // Ignore mouse events (xterm mouse reporting)
    if (/\x1b\[M/.test(data) || /\x1b\[</.test(data)) {
      return;
    }

    // Ignore focus events
    if (/\x1b\[I/.test(data) || /\x1b\[O/.test(data)) {
      return;
    }

    // Strip ANSI codes and control characters for analysis.
    //
    // The CSI matcher follows the ECMA-48 grammar: ESC [ · parameter bytes
    // (0x30–0x3F, which INCLUDE the private-mode markers ? < = >) · intermediate
    // bytes (0x20–0x2F) · final byte (0x40–0x7E). The previous pattern only
    // allowed [0-9;] params, so private-mode sequences leaked their tail into
    // "printable" content — most notably DSR cursor-position queries (ESC[?6n)
    // that some agent TUIs emit several times a second when no viewer is
    // attached to answer them. Those 4-char remnants accumulated past the
    // "sustained output" threshold and produced phantom idle→working blips.
    const cleanData = data
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // NOSONAR(S6324) ESC (0x1B) is required to strip CSI/DSR/SGR/mouse control sequences
      .replace(/\x1b\][^\x07]*\x07/g, '')      // OSC sequences
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // DCS, SOS, PM, APC sequences
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // Control chars (keep \n, \r, \t)

    const printableContent = cleanData.replace(/\s/g, '').trim();

    // Ignore tiny outputs (cursor moves, redraws, etc.)
    if (printableContent.length < 3) {
      return;
    }

    // Ignore if raw data is mostly control sequences (resize/redraw events)
    // If less than 10% is printable content, it's likely a terminal control event
    if (data.length > 20 && printableContent.length < data.length * 0.1) {
      return;
    }

    // Add to output buffer for pattern matching
    session.outputBuffer = (session.outputBuffer + cleanData).slice(-2000);

    // Track recent output volume (reset if gap > 1 second)
    if (now - session.lastOutputTime > 1000) {
      session.recentOutputBytes = 0;
    }
    session.recentOutputBytes += printableContent.length;
    session.lastOutputTime = now;

    // Did the CLI just say the account is out of quota? Checked before the
    // waiting-state work below because the two are not alternatives: a limited
    // Claude usually parks at its prompt, so this would otherwise be read as an
    // ordinary "waiting for input" and nothing would ever move.
    //
    // A wider slice than the waiting check gets: the announcement and its
    // "resets at" clause can be a couple of wrapped lines apart, and the reset
    // time is the whole difference between a five-hour default cooldown and
    // the real one.
    this.checkUsageLimit(id, session);

    // Detect waiting for user input patterns (check recent buffer).
    // Generic prompt shapes plus whatever the session's provider knows about
    // its own TUI (selection menus, permission dialogs).
    const recentBuffer = session.outputBuffer.slice(-500);
    const waitingPatterns = getWaitingPatterns(session.provider);

    if (waitingPatterns.some((pattern) => pattern.test(recentBuffer))) {
      this.transitionToWaiting(id, session, now);
    } else {
      this.scheduleWorkingTransition(id, session);
    }

    // Only reset idle timeout if there's substantial output (>10 printable chars)
    // This prevents cursor blinks and status updates from keeping "working" alive
    const isSubstantialOutput = printableContent.length > 10;

    if (isSubstantialOutput) {
      if (session.idleTimeout) {
        clearTimeout(session.idleTimeout);
        session.idleTimeout = null;
      }
    }

    // Set idle timeout if in working state and no active timeout
    if (session.lastState === 'working') {
      this.scheduleIdleTimeout(id);
    }
  }
}

export const ptyManager = new PtyManager();
