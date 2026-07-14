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
import { ArenaStreamParser, ollamaParser } from './parsers';
import { ArenaRun, ArenaUpdate, ArenaResponseStatus } from '../../shared/types';

export const OLLAMA_CONTESTANT_ID = 'ollama';
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
/** Generous default cap so a hung CLI can't leave a column spinning forever. */
const DEFAULT_CONTESTANT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Kill the contestant's whole process tree. The CLI runs as a child of the
 * wrapper shell, so signalling just the shell would leave the actual agent
 * process running detached. POSIX contestants are spawned detached (own
 * process group) and killed by group; Windows uses taskkill /T.
 */
function killTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    // Absolute path so a poisoned PATH can't substitute the binary (S4036).
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/F', '/T', '/PID', String(child.pid)], () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

interface LiveResponse {
  runId: string;
  provider: string;
  prompt: string;
  text: string;
  startedAt: number;
  ttftMs: number | null;
  launched: boolean;
  kill: (() => void) | null;
}

export class ArenaEngine extends EventEmitter {
  private readonly live: Map<string, LiveResponse> = new Map();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_CONTESTANT_TIMEOUT_MS) {
    super();
    this.timeoutMs = timeoutMs;
  }

  /** Phase 1: create the run + response rows; nothing is spawned yet. */
  prepare(prompt: string, contestants: string[]): ArenaRun {
    const runId = randomUUID();
    arenaRepo.createRun(runId, prompt);
    for (const provider of contestants) {
      const responseId = randomUUID();
      arenaRepo.createResponse(responseId, runId, provider);
      this.live.set(responseId, {
        runId,
        provider,
        prompt,
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

  /** Phase 2: spawn every contestant of a prepared run. */
  launch(runId: string): void {
    for (const [responseId, entry] of this.live) {
      if (entry.runId !== runId || entry.launched) continue;
      entry.launched = true;
      if (entry.provider === OLLAMA_CONTESTANT_ID) {
        void this.runOllama(responseId, entry.prompt);
      } else {
        this.runCli(responseId, entry.provider, entry.prompt);
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

  private runCli(responseId: string, providerId: string, prompt: string): void {
    const entry = this.live.get(responseId);
    if (!entry) return;
    let provider: ReturnType<typeof getProvider>;
    try {
      provider = getProvider(providerId);
    } catch {
      this.finish(responseId, 'error', null, `Unknown contestant: ${providerId}`);
      return;
    }

    const shellInfo = detectShell(getPreference('customShellPath') ?? '');
    const shellLaunch = getShellLaunch(shellInfo);
    const cmd = provider.arena.buildCommand(shellLaunch.envRef('ARENA_PROMPT'));
    const parser = provider.arena.createParser();

    const child = spawn(shellLaunch.shell, shellLaunch.wrap(cmd), {
      env: { ...process.env, ARENA_PROMPT: prompt },
      windowsHide: true,
      // Own process group on POSIX so killTree can signal the whole tree.
      detached: process.platform !== 'win32',
    });
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

    const rl = readline.createInterface({ input: child.stdout! });
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

  private async runOllama(responseId: string, prompt: string): Promise<void> {
    const entry = this.live.get(responseId);
    if (!entry) return;
    const parser = ollamaParser();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    entry.kill = () => {
      clearTimeout(timeout);
      controller.abort();
    };

    try {
      // Use the first locally available model.
      const tags = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
      const model: string | undefined = (await tags.json())?.models?.[0]?.name;
      if (!model) {
        this.finish(responseId, 'error', null, 'Ollama is running but has no models pulled');
        return;
      }
      entry.startedAt = Date.now();

      const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
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
