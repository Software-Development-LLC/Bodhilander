/**
 * A run prepared inside BodhiCrew: posix paths, the WSL2 sandbox settings,
 * a private TMPDIR, and a crew-agent session relaying the run's gateway and
 * MCP connections to this process. It is launched through wsl.exe exec-run.
 */
import { posix } from 'path';
import { duplexPair, type Duplex } from 'stream';
import type Database from 'better-sqlite3';
import type { ClaudeAccount } from '../../shared/types';
import { resolveAccountRef } from './account-ref';
import type { ApproveBroker } from './approve/broker';
import type { CrewSignIn } from './crew-token';
import type { GatewayRun } from './gateway/github-gateway';
import type { McpRun, McpServerHandler } from './mcp/host';
import { runArgs, wslRunEnv } from './run/env';
import type { CrewJob, Prepared } from './run/loop';
import { crewMcpServers } from './run/mcp-config';
import { chooseSession, HOLD_MISSING, HOLD_SETUP, HOLD_SIGNED_OUT, hireAccountRef } from './run/prepare';
import { buildWslRunSettings, WSL_BIN_DIR, WSL_CREW_DIR, WSL_HIRES_DIR, WSL_HOME_ROOT, WSL_NODE_DIR, wslHirePaths } from './run/sandbox-settings';
import { cwdFor } from './run/scope';
import { makeWslTmpDir, newRunToken, removeWslTmpDir, runDirName, SocketRootError, type DistroSh, type TmpRecords } from './run/sockets';
import { CREW_HOME, type WslExec } from './wsl';
import { AgentVersionError, startAgent, wslLaunch, type AgentChild, type AgentSession } from './wsl-agent';
import { CLAUDE_BIN, writeIntoDistro } from './wsl-setup';

export const WSL_ACCOUNTS_DIR = `${WSL_CREW_DIR}/accounts`;
export const WSL_MCP_RELAY = `${WSL_BIN_DIR}/crew-mcp.js`;
export const WSL_GH_SHIM_DIR = `${WSL_BIN_DIR}/gh-shim`;
const WSL_NODE = `${WSL_NODE_DIR}/bin/node`;
const CREW_UID = 1000;

/** An account's config dir inside BodhiCrew; its Windows-side token is never copied there. */
export function wslAccountDir(accountId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId)) throw new Error(`not an account id: ${accountId}`);
  return posix.join(WSL_ACCOUNTS_DIR, accountId);
}

export interface WslRunDeps {
  db: Database.Database;
  signIn: CrewSignIn;
  accounts(): ClaudeAccount[];
  exec: WslExec;
  sh: DistroSh;
  records: TmpRecords;
  host: { register(run: McpRun): string; unregister(jobId: string): void; accept(conn: Duplex): void };
  gateway: { accept(run: GatewayRun, conn: Duplex): void };
  broker(): ApproveBroker | null;
  tools(job: CrewJob, threadKey: string): McpServerHandler;
  repos(hireId: string): string[];
  agentVersion: string;
  spawnAgent(): AgentChild;
  reinstallAgent(): Promise<boolean>;
  /** The agent's stdio closed mid-run: the run is interrupted and its job re-queued. */
  onLost(hireId: string): void;
  handbook(hireId: string): string;
  timeZone(): string | null;
  model?(hireId: string): string | undefined;
  allowedDomains?(): string[];
  now?(): number;
}

interface Open {
  session: AgentSession | null;
  tmpName: string | null;
  conns: Set<Duplex>;
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Each directory from /home down to the hires dir, with its entries, for the file-tool denies. */
async function listLevels(sh: DistroSh): Promise<Record<string, string[]>> {
  const dirs = [WSL_HOME_ROOT, CREW_HOME, posix.dirname(WSL_CREW_DIR), WSL_CREW_DIR, WSL_HIRES_DIR];
  const r = await sh(dirs.map((d) => `for e in ${q(d)}/* ${q(d)}/.[!.]*; do [ -e "$e" ] && printf '%s\\n' "$e"; done`).join('; '));
  const levels: Record<string, string[]> = Object.fromEntries(dirs.map((d) => [d, []]));
  for (const line of r.stdout.split('\n')) {
    const dir = posix.dirname(line);
    if (levels[dir]) levels[dir].push(posix.basename(line));
  }
  return levels;
}

export class WslRuns {
  private readonly open = new Map<string, Open>();

  constructor(private readonly deps: WslRunDeps) {}

  async prepare(job: CrewJob, threadKey: string, runId: string): Promise<Prepared> {
    const d = this.deps;
    const now = d.now?.() ?? Date.now();
    const ref = hireAccountRef(d.db, job.hireId);
    const account = ref ? resolveAccountRef(ref, d.accounts()) : null;
    if (!account) return { hold: HOLD_MISSING };
    const loggedIn = d.signIn.mode() === 'login' ? await this.loggedIn(account.id) : undefined;
    if (!d.signIn.signedIn(account.id, loggedIn, now)) return { hold: HOLD_SIGNED_OUT };
    const token = d.signIn.mode() === 'token' ? d.signIn.tokenFor(account.id, now) : null;
    if (d.signIn.mode() === 'token' && token === null) return { hold: HOLD_SIGNED_OUT };
    const broker = d.broker();
    if (!broker) return { hold: HOLD_SETUP };

    this.end(job.id);
    const open: Open = { session: null, tmpName: null, conns: new Set() };
    this.open.set(job.id, open);
    try {
      return await this.build(job, threadKey, runId, account.id, token, broker, open, now);
    } catch (err) {
      this.end(job.id);
      if (err instanceof SocketRootError || err instanceof AgentVersionError) return { hold: HOLD_SETUP };
      throw err;
    }
  }

  private async build(job: CrewJob, threadKey: string, runId: string, accountId: string, token: string | null, broker: ApproveBroker, open: Open, now: number): Promise<Prepared> {
    const d = this.deps;
    const records: TmpRecords = {
      add: (name) => ((open.tmpName = name), d.records.add(name)),
      remove: (name) => d.records.remove(name),
      list: () => d.records.list(),
    };
    const tmpDir = await makeWslTmpDir(d.sh, CREW_UID, records);
    const gatewayToken = newRunToken();
    const gatewayRun: GatewayRun = { jobId: job.id, hireId: job.hireId, threadKey, requestedBy: job.requestedBy, repos: d.repos(job.hireId), token: gatewayToken };
    const mcpToken = d.host.register({
      jobId: job.id,
      hireId: job.hireId,
      servers: {
        approve: broker.handler({ jobId: job.id, hireId: job.hireId, threadKey, scope: job.scope, requestedBy: job.requestedBy }),
        tools: d.tools(job, threadKey),
      },
    });
    const connect = (sock: string): Duplex => {
      const [ours, theirs] = duplexPair();
      open.conns.add(ours);
      ours.on('close', () => open.conns.delete(ours));
      if (sock === 'gh') d.gateway.accept(gatewayRun, theirs);
      else d.host.accept(theirs);
      return ours;
    };
    const started = await startAgent({
      spawn: d.spawnAgent,
      reinstall: d.reinstallAgent,
      version: d.agentVersion,
      uid: CREW_UID,
      name: runDirName(runId),
      sockets: ['gh'],
      privateSockets: ['mcp'],
      now: () => d.now?.() ?? Date.now(),
      connect,
      onLost: () => d.onLost(job.hireId),
    });
    open.session = started.session;

    const paths = wslHirePaths(job.hireId);
    const cwd = cwdFor(paths, job.scope);
    const configDir = wslAccountDir(accountId);
    const mk = [paths.owner, paths.circle, paths.run, paths.ghConfig, paths.shell, configDir].map(q).join(' ');
    const regen = await d.sh(`umask 077 && mkdir -p ${mk} && rm -rf ${q(posix.join(cwd, '.claude'))}`);
    if (regen.code !== 0) throw new SocketRootError({ type: 'hire-folder', uid: null, mode: null });
    await this.write(posix.join(cwd, 'CLAUDE.md'), d.handbook(job.hireId), '0644');

    const settings = buildWslRunSettings({
      hireId: job.hireId,
      scope: job.scope,
      uid: CREW_UID,
      configDir,
      accountDirs: [WSL_ACCOUNTS_DIR],
      clones: [],
      runDir: started.served.dir,
      tmpDir,
      levels: await listLevels(d.sh),
      allowedDomains: d.allowedDomains?.() ?? [],
    });
    const settingsPath = posix.join(paths.run, `settings-${job.scope}.json`);
    const mcpConfigPath = posix.join(paths.run, `mcp-${job.scope}.json`);
    await this.write(settingsPath, JSON.stringify(settings, null, 2), '0600');
    const mcpServers = crewMcpServers({ execPath: WSL_NODE, script: WSL_MCP_RELAY, socket: started.served.sockets.mcp, token: mcpToken });
    await this.write(mcpConfigPath, JSON.stringify({ mcpServers }), '0600');

    const { sessionId, input } = chooseSession(d.db, job, threadKey, now, d.timeZone());
    const gh = started.served.sockets.gh;
    return wslLaunch({
      command: CLAUDE_BIN,
      args: runArgs({ sessionId, settingsPath, mcpConfigPath, model: d.model?.(job.hireId) }),
      cwd,
      env: wslRunEnv({
        configDir,
        ghConfigDir: paths.ghConfig,
        shellDir: paths.shell,
        tokenOnFd: token !== null,
        pathFirst: WSL_GH_SHIM_DIR,
        extra: { CREW_GH_SOCKET: gh, CREW_GH_TOKEN: gatewayToken, CREW_NODE: WSL_NODE, CREW_GH_SHIM_JS: `${WSL_GH_SHIM_DIR}/gh-shim.js` },
        tmpDir,
        home: CREW_HOME,
        user: 'crew',
      }),
      input,
      accountId,
      sessionId,
      token,
    });
  }

  /** The login fallback's credentials live in the account's dir inside BodhiCrew. */
  private async loggedIn(accountId: string): Promise<boolean> {
    const r = await this.deps.sh(`test -s ${q(posix.join(wslAccountDir(accountId), '.credentials.json'))}`);
    return r.code === 0;
  }

  private async write(dest: string, body: string, mode: string): Promise<void> {
    const r = await writeIntoDistro(this.deps.exec, dest, body, mode);
    if (r.code !== 0) throw new Error(`could not write ${dest} in BodhiCrew`);
  }

  /** Every outcome ends here: the agent stopped, its relays closed, the MCP token retired, the TMPDIR removed. */
  end(jobId: string): void {
    const open = this.open.get(jobId);
    this.open.delete(jobId);
    this.deps.host.unregister(jobId);
    if (!open) return;
    open.session?.stop();
    for (const c of open.conns) c.destroy();
    if (open.tmpName) void removeWslTmpDir(this.deps.sh, CREW_UID, this.deps.records, open.tmpName).catch(() => undefined);
  }

  endAll(): void {
    for (const id of [...this.open.keys()]) this.end(id);
  }

  /** The names of TMPDIRs a live run still owns, for the start sweep. */
  liveTmpNames(): Set<string> {
    return new Set([...this.open.values()].flatMap((o) => (o.tmpName ? [o.tmpName] : [])));
  }
}
