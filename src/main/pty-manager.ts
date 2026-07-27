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
import { ProviderInstallHint } from '../shared/types';
import { getShellLaunch } from './shell-launch';
import { getPreference } from './repositories/preferences';
import {
  getClaudeSessionId as getStoredClaudeSessionId,
  setClaudeSessionId as storeClaudeSessionId,
  clearClaudeSessionId as clearStoredClaudeSessionId,
} from './repositories/sessions';
import { resolveAccountForSession, touchAccount } from './repositories/accounts';
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
  idleTimeout: NodeJS.Timeout | null;
  workingDebounce: NodeJS.Timeout | null;
  recentOutputBytes: number;
  lastOutputTime: number;
  /** Whether this spawn used the provider's resume flag. Used to detect resume failure on early exit. */
  resumeAttempted: boolean;
  /** Wall-clock spawn time (ms) for early-exit detection. */
  spawnedAt: number;
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
  private socketPath: string;

  constructor() {
    super();
    this.socketPath = getSocketPath();
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
    providerId: string = DEFAULT_PROVIDER_ID
  ): void {
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

    if (provider) {
      const agentSpawn = this.buildAgentSpawn(provider, id, cwd, shellInfo);
      shell = agentSpawn.shell;
      args = agentSpawn.args;
      env = agentSpawn.env;
      resumeAttempted = agentSpawn.resumeAttempted;
    } else {
      shell = shellInfo.shell;
      args = shellInfo.args;
    }

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: shellInfo.isWSL && !launchClaude ? undefined : cwd,
      env: env,
      // Windows ConPTY options to reduce race conditions (error 299)
      ...(process.platform === 'win32' ? {
        useConptyDll: true,  // Use bundled ConPTY DLL from Windows Terminal (often newer/more stable)
        conptyInheritCursor: false,  // Don't inherit cursor - cleaner startup
      } : {}),
    });

    ptyProcess.onData((data) => {
      const session = this.sessions.get(id);
      // Guard: reject data from a PTY that is being torn down
      if (!session || session.killing) return;

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
      // Resume-failure fallback (BDHLNDR-9): if we launched the agent with its
      // resume flag and it exited non-zero within the failure window, treat
      // that as a dead session and transparently respawn with a fresh UUID.
      // The renderer never sees an 'exit' event for this path — it just sees
      // new output from the replacement pty.
      const session = this.sessions.get(id);
      if (
        session?.provider
        && session.resumeAttempted
        && exitCode !== 0
        && Date.now() - session.spawnedAt < RESUME_FAILURE_WINDOW_MS
      ) {
        log.warn(
          `[PTY] ${session.provider.name} resume failed for session ${id} (exitCode=${exitCode}, ` +
          `age=${Date.now() - session.spawnedAt}ms). Clearing stored session ID ` +
          `and retrying with a fresh agent session.`
        );
        try {
          clearStoredClaudeSessionId(id);
        } catch (e) {
          log.error(`[PTY] Failed to clear claude_session_id for ${id}:`, e);
        }
        // Remove the dead entry so createSession can re-insert a fresh one.
        this.sessions.delete(id);
        try {
          this.createSession(id, cwd, true, providerId);
          return; // Successful retry — suppress the exit emission.
        } catch (e) {
          log.error(`[PTY] Resume-failure retry spawn failed for ${id}:`, e);
          // Fall through to emit the original exit so the UI recovers.
        }
      }

      this.emit('exit', { id, exitCode });
      this.sessions.delete(id);
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
      idleTimeout: null,
      workingDebounce: null,
      recentOutputBytes: 0,
      lastOutputTime: 0,
      resumeAttempted,
      spawnedAt: Date.now(),
      lastCols: 80,
      lastRows: 24,
      killing: false,
      spawnFailureNotified: false,
      launchOutput: '',
      // Regular sessions spawn only after the renderer explicitly called
      // pty:create, so listeners are already attached — no deferral needed.
      deferEmission: false,
    });

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
  ): { shell: string; args: string[]; env: { [key: string]: string }; resumeAttempted: boolean } {
    let agentSessionId: string | null = null;
    let agentSessionMode: AgentSessionMode | null = null;

    if (provider.capabilities.resume) {
      // Resolve the agent conversation UUID + mode (BDHLNDR-9).
      // If we have a stored ID, we're restarting and should resume. Otherwise
      // generate a fresh UUID, pass it via the provider's new-session flag,
      // and persist it so the NEXT launch can resume.
      const storedAgentSessionId = getStoredClaudeSessionId(id);
      if (storedAgentSessionId) {
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
      if (!session || session.killing) return;

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
      idleTimeout: null,
      workingDebounce: null,
      recentOutputBytes: 0,
      lastOutputTime: 0,
      resumeAttempted: false,
      spawnedAt: Date.now(),
      lastCols: 80,
      lastRows: 24,
      killing: false,
      spawnFailureNotified: false,
      launchOutput: '',
      // Spawned before the renderer's Terminal mounts — same race as the
      // login pty (BDHLNDR-33).
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
      if (!session || session.killing) return;

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
      idleTimeout: null,
      workingDebounce: null,
      recentOutputBytes: 0,
      lastOutputTime: 0,
      resumeAttempted: false,
      spawnedAt: Date.now(),
      lastCols: 80,
      lastRows: 24,
      killing: false,
      spawnFailureNotified: false,
      launchOutput: '',
      // Login ptys defer event emission until the renderer attaches its
      // listener and calls primePty — avoids losing claude's startup banner
      // in the IPC-round-trip + React-render gap (BDHLNDR-33).
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

  kill(id: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const session = this.sessions.get(id);
      if (!session) {
        resolve();
        return;
      }

      // Mark as killing FIRST — prevents write/resize/onData from touching
      // the native PTY handle during teardown.
      session.killing = true;

      if (session.idleTimeout) {
        clearTimeout(session.idleTimeout);
      }
      if (session.workingDebounce) {
        clearTimeout(session.workingDebounce);
      }

      const pid = session.pty.pid;

      // Remove from map BEFORE calling pty.kill() so concurrent IPC calls
      // (write, resize) get a null lookup and bail out instead of hitting
      // a freed native handle.
      this.sessions.delete(id);

      // Send graceful kill signal
      session.pty.kill();

      // The onExit handler registered in createSession will fire and emit
      // the 'exit' event. We just need to resolve this promise once the
      // process is gone.
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      // Force-kill after 3 seconds if process hasn't exited (Windows only)
      if (process.platform === 'win32' && pid) {
        setTimeout(() => {
          if (!resolved) {
            log.warn(`[PTY] Force-killing session ${id} (pid ${pid}) after 3s timeout`);
            try {
              execFile('taskkill', ['/F', '/T', '/PID', String(pid)], (err) => {
                if (err) {
                  log.error(`[PTY] taskkill failed for pid ${pid}:`, err);
                }
                done();
              });
            } catch (err) {
              log.error(`[PTY] Failed to spawn taskkill for pid ${pid}:`, err);
              done();
            }
          }
        }, 3000);
      } else {
        // On non-Windows, fall back to a timeout cleanup
        setTimeout(() => {
          if (!resolved) {
            log.warn(`[PTY] Session ${id} did not exit within 3s, cleaning up`);
            done();
          }
        }, 3000);
      }
    });
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
      console.warn('[PtyManager] getSerializedBuffer failed, falling back to raw:', err);
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
      const sess = this.sessions.get(id);
      if (sess && sess.lastState === 'working') {
        sess.lastState = 'idle';
        sess.recentOutputBytes = 0;
        sess.idleTimeout = null;
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
      const currentSession = this.sessions.get(id);
      if (currentSession && currentSession.recentOutputBytes > 200) {
        currentSession.lastState = 'working';
        currentSession.workingDebounce = null;
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
