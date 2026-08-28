/**
 * Arena engine (#100): fans one prompt out to N contestants concurrently,
 * streams their output as 'update' events, and persists final text + metrics.
 *
 * CLI contestants run headless under the user's existing login/subscription
 * (never an API key — see issue #100's subscription-preservation decision),
 * spawned through the user's shell exactly like sessions are. The prompt is
 * passed via the ARENA_PROMPT environment variable and referenced with the
 * shell's own env syntax, so prompt text never touches the command string.
 *
 * Ollama is the one non-CLI contestant: a keyless HTTP call to the local
 * daemon, streaming /api/chat.
 *
 * Two-phase start: prepare() creates the run + response rows WITHOUT
 * launching anything, so the renderer can learn the run id and subscribe
 * before launch() spawns the contestants — otherwise a fast-failing CLI
 * could emit its final update before the renderer knew the run id, leaving
 * a column stuck on "running".
 */
import { spawn, execFile, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import log from 'electron-log';
import { getProvider } from '../providers';
import { getShellLaunch } from '../shell-launch';
import { detectShell } from '../shell-detector';
import { getPreference } from '../repositories/preferences';
import * as arenaRepo from '../repositories/arena';
import { vaultEnvFor } from '../key-vault';
import { redactEnv } from '../redact-env';
import { ArenaStreamParser, ollamaParser } from './parsers';
import { ArenaResponse, ArenaRun, ArenaUpdate, ArenaResponseStatus } from '../../shared/types';

export const OLLAMA_CONTESTANT_ID = 'ollama';
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
/** Generous default cap so a hung CLI can't leave a column spinning forever. */
const DEFAULT_CONTESTANT_TIMEOUT_MS = 5 * 60 * 1000;

/** Grace period between SIGTERM and the SIGKILL escalation. */
const KILL_GRACE_MS = 3000;

/**
 * Kill the contestant's whole process tree. The CLI runs as a child of the
 * wrapper shell, so signalling just the shell would leave the actual agent
 * process running detached. POSIX contestants are spawned detached (own
 * process group) and killed by group, escalating to SIGKILL if the tree
 * ignores SIGTERM — otherwise 'close' never fires and the column would sit
 * on "running" forever. Windows taskkill /F is already forceful.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    // Absolute path so a poisoned PATH can't substitute the binary (S4036).
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/F', '/T', '/PID', String(pid)], () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill();
    return;
  }
  const escalation = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Process group already gone — nothing to escalate.
    }
  }, KILL_GRACE_MS);
  escalation.unref?.();
  child.once('close', () => clearTimeout(escalation));
}

interface OllamaMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface LiveResponse {
  runId: string;
  provider: string;
  prompt: string;
  /** Project folder CLI contestants spawn in (null = engine process cwd). */
  workingDir: string | null;
  /** Conversation round: 0 = initial prompt, 1+ = follow-ups. */
  round: number;
  /** CLI session id: engine-assigned on round 0, resumed on later rounds. */
  sessionRef: string | null;
  /** True when this entry resumes an earlier round's session. */
  resume: boolean;
  /**
   * Ollama has no CLI session to resume — follow-ups replay the prior
   * conversation as an explicit message history (null for CLI contestants).
   */
  ollamaMessages: OllamaMessage[] | null;
  text: string;
  startedAt: number;
  ttftMs: number | null;
  launched: boolean;
  kill: (() => void) | null;
}

/**
 * Session refs are inlined into shell command strings (--resume <ref>), so
 * only pass ones that cannot break out of the command: UUIDs and codex
 * thread ids match this; anything else is rejected rather than spawned.
 */
const SESSION_REF_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Continuation seed for one provider's next round, or null when the column
 * can't continue (latest round didn't finish cleanly, nothing to resume, or
 * the CLI has no headless resume). `rounds` is that provider's responses in
 * round order.
 */
function followUpSeed(
  provider: string,
  rounds: ArenaResponse[],
  runPrompt: string,
  prompt: string,
): Pick<LiveResponse, 'sessionRef' | 'ollamaMessages'> | null {
  const latest = rounds[rounds.length - 1];
  if (latest.status !== 'done') return null;

  if (provider === OLLAMA_CONTESTANT_ID) {
    if (!latest.text) return null;
    // Ollama has no server-side session — replay every prior round as
    // explicit chat history.
    const messages: OllamaMessage[] = rounds.flatMap((r) => [
      { role: 'user' as const, content: r.prompt ?? runPrompt },
      { role: 'assistant' as const, content: r.text },
    ]);
    messages.push({ role: 'user', content: prompt });
    return { sessionRef: null, ollamaMessages: messages };
  }

  if (!latest.sessionRef || !SESSION_REF_SAFE.test(latest.sessionRef)) return null;
  let providerDef: ReturnType<typeof getProvider>;
  try {
    providerDef = getProvider(provider);
  } catch {
    return null; // provider removed from the registry since the run
  }
  if (!providerDef.arena.buildResumeCommand) return null;
  return { sessionRef: latest.sessionRef, ollamaMessages: null };
}

export class ArenaEngine extends EventEmitter {
  private readonly live: Map<string, LiveResponse> = new Map();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_CONTESTANT_TIMEOUT_MS) {
    super();
    this.timeoutMs = timeoutMs;
  }

  /**
   * Phase 1: create the run + response rows; nothing is spawned yet.
   * workingDir scopes CLI contestants to a project folder so they answer
   * with that codebase as context (Ollama, a bare HTTP chat, ignores it).
   */
  prepare(prompt: string, contestants: string[], workingDir: string | null = null): ArenaRun {
    const runId = randomUUID();
    arenaRepo.createRun(runId, prompt, workingDir);
    for (const provider of contestants) {
      const responseId = randomUUID();
      arenaRepo.createResponse(responseId, runId, provider);
      this.live.set(responseId, {
        runId,
        provider,
        prompt,
        workingDir,
        round: 0,
        // Name the CLI session upfront so the run can be resumed later.
        // CLIs that mint their own id (codex) ignore this; their parser
        // reports the real one, which wins at finalize.
        sessionRef: provider === OLLAMA_CONTESTANT_ID ? null : randomUUID(),
        resume: false,
        ollamaMessages: null,
        text: '',
        startedAt: Date.now(),
        ttftMs: null,
        launched: false,
        kill: null,
      });
    }
    const run = arenaRepo.getRun(runId);
    if (!run) throw new Error('Arena run vanished immediately after creation');
    return run;
  }

  /**
   * Phase 1 of a follow-up round: create response rows for every contestant
   * of the run that can continue — CLI contestants resume their session
   * (session_ref + a resume command), Ollama replays the conversation as
   * message history. Columns whose latest round errored (or whose CLI has no
   * headless resume) simply don't get a new round. Same two-phase contract
   * as prepare(): nothing spawns until launch().
   */
  prepareFollowUp(runId: string, prompt: string): ArenaRun {
    const run = arenaRepo.getRun(runId);
    if (!run) throw new Error(`Arena run not found: ${runId}`);
    if (run.responses.some((r) => r.status === 'running')) {
      throw new Error('Arena run still has contestants running');
    }

    const nextRound = Math.max(...run.responses.map((r) => r.round)) + 1;
    let continued = 0;

    for (const provider of new Set(run.responses.map((r) => r.provider))) {
      const rounds = run.responses.filter((r) => r.provider === provider);
      const entrySeed = followUpSeed(provider, rounds, run.prompt, prompt);
      if (!entrySeed) continue;

      const responseId = randomUUID();
      arenaRepo.createResponse(responseId, runId, provider, nextRound, prompt);
      this.live.set(responseId, {
        runId,
        provider,
        prompt,
        workingDir: run.workingDir,
        round: nextRound,
        resume: true,
        text: '',
        startedAt: Date.now(),
        ttftMs: null,
        launched: false,
        kill: null,
        ...entrySeed,
      });
      continued += 1;
    }

    if (continued === 0) {
      throw new Error('No contestant in this run can be resumed');
    }
    const updated = arenaRepo.getRun(runId);
    if (!updated) throw new Error('Arena run vanished during follow-up');
    return updated;
  }

  /** Phase 2: spawn every contestant of a prepared run. */
  launch(runId: string): void {
    for (const [responseId, entry] of this.live) {
      if (entry.runId !== runId || entry.launched) continue;
      entry.launched = true;
      if (entry.provider === OLLAMA_CONTESTANT_ID) {
        void this.runOllama(responseId, entry);
      } else {
        this.runCli(responseId, entry);
      }
    }
  }

  cancelRun(runId: string): void {
    for (const [responseId, entry] of this.live) {
      if (entry.runId === runId) {
        entry.kill?.();
        this.finish(responseId, 'error', null, 'Cancelled');
      }
    }
  }

  private runCli(responseId: string, entry: LiveResponse): void {
    const providerId = entry.provider;
    let provider: ReturnType<typeof getProvider>;
    try {
      provider = getProvider(providerId);
    } catch {
      this.finish(responseId, 'error', null, `Unknown contestant: ${providerId}`);
      return;
    }

    if (!entry.sessionRef || !SESSION_REF_SAFE.test(entry.sessionRef)) {
      // prepare()/prepareFollowUp() always set a validated ref for CLI
      // contestants; reaching here means a bug upstream, not user input.
      this.finish(responseId, 'error', null, 'Invalid session reference');
      return;
    }

    // prepareFollowUp only continues providers that declare a resume
    // command, so this is belt-and-braces rather than a reachable path.
    const build = entry.resume ? provider.arena.buildResumeCommand : provider.arena.buildCommand;
    if (!build) {
      this.finish(responseId, 'error', null, `${providerId} cannot resume a session`);
      return;
    }

    const shellInfo = detectShell(getPreference('customShellPath') ?? '');
    const shellLaunch = getShellLaunch(shellInfo, { needsEnvRef: true });
    const cmd = build(shellLaunch.envRef('ARENA_PROMPT'), entry.sessionRef);
    const parser = provider.arena.createParser();

    // vaultEnvFor is empty unless the user opted this provider into
    // API-key auth (#99) — subscription/CLI login stays the default.
    const vaultEnv = vaultEnvFor(providerId);
    if (Object.keys(vaultEnv).length > 0) {
      // Visibility that key auth is active; values scrubbed via redactEnv.
      log.info(`[Arena] API-key auth enabled for '${providerId}':`, redactEnv(vaultEnv));
    }
    const child = spawn(shellLaunch.shell, shellLaunch.wrap(cmd), {
      env: { ...process.env, ARENA_PROMPT: entry.prompt, ...vaultEnv },
      // Scoped runs put the CLI inside the project folder, exactly like a
      // terminal session there. A vanished dir surfaces via the 'error'
      // handler below (spawn ENOENT), settling the column as an error.
      cwd: entry.workingDir ?? undefined,
      windowsHide: true,
      // Own process group on POSIX so killTree can signal the whole tree.
      detached: process.platform !== 'win32',
    });
    // The prompt travels via ARENA_PROMPT, never stdin — close it so CLIs
    // that read stdin to EOF when it isn't a TTY don't block forever waiting
    // for input that will never come (codex exec hangs; claude warns). Same
    // fix as the provider detector's probe (#111).
    child.stdin?.end();
    entry.startedAt = Date.now();

    const timeout = setTimeout(() => {
      log.warn(`[Arena] ${providerId} timed out after ${this.timeoutMs}ms`);
      killTree(child);
    }, this.timeoutMs);
    entry.kill = () => {
      clearTimeout(timeout);
      killTree(child);
    };

    let stderrTail = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-2000);
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      this.appendChunk(responseId, parser.onLine(line));
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      this.finish(responseId, 'error', null, `Failed to launch: ${err.message}`);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (!this.live.has(responseId)) return; // already finished (error/cancel)
      const final = parser.finalize();
      this.appendChunk(responseId, final.trailingText);
      if (code === 0) {
        this.finish(responseId, 'done', final, null);
      } else {
        // code === null means killed by signal (timeout or cancel).
        const fallback = code === null ? 'terminated' : `exit code ${code}`;
        const detail = stderrTail.trim() || fallback;
        this.finish(responseId, 'error', final, detail.slice(0, 500));
      }
    });
  }

  private async runOllama(responseId: string, entry: LiveResponse): Promise<void> {
    // Follow-ups replay the prior rounds as message history (Ollama has no
    // server-side session); round 0 is just the single prompt.
    const messages: OllamaMessage[] =
      entry.ollamaMessages ?? [{ role: 'user', content: entry.prompt }];
    const parser = ollamaParser();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    entry.kill = () => {
      clearTimeout(timeout);
      controller.abort();
    };
    // Clock starts at the launch attempt so error paths (no models, daemon
    // down) don't inherit the prepare()→launch() gap in totalMs.
    entry.startedAt = Date.now();

    try {
      // Use the first locally available model.
      const tags = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
      const model: string | undefined = (await tags.json())?.models?.[0]?.name;
      if (!model) {
        this.finish(responseId, 'error', null, 'Ollama is running but has no models pulled');
        return;
      }

      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true }),
      });
      if (!res.ok || !res.body) {
        this.finish(responseId, 'error', null, `Ollama returned HTTP ${res.status}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          this.appendChunk(responseId, parser.onLine(line));
        }
      }
      if (buffered) this.appendChunk(responseId, parser.onLine(buffered));
      this.finish(responseId, 'done', parser.finalize(), null);
    } catch (err: any) {
      const message = err?.name === 'AbortError'
        ? 'Timed out'
        : `Ollama not reachable at ${OLLAMA_BASE_URL} (${err?.message ?? err})`;
      this.finish(responseId, 'error', parser.finalize(), message);
    } finally {
      clearTimeout(timeout);
    }
  }

  private appendChunk(responseId: string, chunk: string): void {
    if (!chunk) return;
    const entry = this.live.get(responseId);
    if (!entry) return;
    entry.ttftMs ??= Date.now() - entry.startedAt;
    entry.text += chunk;
    this.emitUpdate(responseId, entry, 'running', chunk, null, null);
  }

  private finish(
    responseId: string,
    status: ArenaResponseStatus,
    final: ReturnType<ArenaStreamParser['finalize']> | null,
    error: string | null
  ): void {
    const entry = this.live.get(responseId);
    if (!entry) return;
    this.live.delete(responseId);

    const totalMs = Date.now() - entry.startedAt;
    // Prefer the CLI's own TTFT measurement when it reports one (claude):
    // it excludes process startup, ours includes it — theirs is the honest
    // model-latency number, ours still shows in total.
    const ttftMs = final?.reportedTtftMs ?? entry.ttftMs;
    // Same preference for the session ref: CLIs that mint their own id
    // report it in-stream (codex thread.started); otherwise the engine's
    // assigned id stands. Persisted so follow-up rounds can resume.
    const sessionRef = final?.sessionRef ?? entry.sessionRef;

    try {
      arenaRepo.finalizeResponse(responseId, {
        status,
        text: entry.text,
        ttftMs,
        totalMs,
        inputTokens: final?.inputTokens ?? null,
        outputTokens: final?.outputTokens ?? null,
        costUsd: final?.costUsd ?? null,
        error,
        sessionRef,
      });
    } catch (e) {
      log.error(`[Arena] Failed to persist response ${responseId}:`, e);
    }
    this.emitUpdate(responseId, { ...entry, ttftMs }, status, '', totalMs, final, error);
  }

  private emitUpdate(
    responseId: string,
    entry: Pick<LiveResponse, 'runId' | 'provider' | 'ttftMs'>,
    status: ArenaResponseStatus,
    chunk: string,
    totalMs: number | null,
    final?: ReturnType<ArenaStreamParser['finalize']> | null,
    error: string | null = null
  ): void {
    const update: ArenaUpdate = {
      runId: entry.runId,
      responseId,
      provider: entry.provider,
      chunk,
      status,
      ttftMs: entry.ttftMs,
      totalMs,
      inputTokens: final?.inputTokens ?? null,
      outputTokens: final?.outputTokens ?? null,
      costUsd: final?.costUsd ?? null,
      error,
    };
    this.emit('update', update);
  }
}

export const arenaEngine = new ArenaEngine();
