/**
 * What a run is given before it starts and loses when it ends: its MCP
 * registration (approve broker and Crew tools), a run-private socket
 * directory with the GitHub gateway listening in it, and the shim's env.
 */
import * as path from 'path';
import type { ApproveBroker } from '../approve/broker';
import type { GithubGateway } from '../gateway/github-gateway';
import type { McpHost, McpServerHandler } from '../mcp/host';
import { crewMcpServers } from './mcp-config';
import type { CrewJob } from './loop';
import { ensureSocketRoot, makeRunDir, newRunToken, removeRunDir, socketPath, socketRoot, type SocketFs } from './sockets';

/** Setup that may come right later: the run is held, not failed. */
export class ServicesNotReady extends Error {}

export interface RunServices {
  mcpServers: Record<string, unknown>;
  sockets: string[];
  pathFirst: string;
  env: Record<string, string>;
}

export interface RunServicesDeps {
  host: McpHost;
  broker(): ApproveBroker | null;
  tools(job: CrewJob, threadKey: string): McpServerHandler;
  gateway: GithubGateway;
  repos(hireId: string): string[];
  uid: number;
  execPath: string;
  relayScript: string;
  shimDir: string;
  fsx?: SocketFs;
}

interface Open {
  dir: string;
}

export class RunServiceManager {
  private readonly open = new Map<string, Open>();

  constructor(private readonly deps: RunServicesDeps) {}

  async start(job: CrewJob, threadKey: string, runId: string): Promise<RunServices> {
    const broker = this.deps.broker();
    if (!broker) throw new ServicesNotReady('the approve broker is not running');
    this.end(job.id);
    const root = socketRoot(this.deps.uid);
    ensureSocketRoot(root, this.deps.uid, this.deps.fsx);
    const dir = makeRunDir(root, runId, this.deps.fsx);
    this.open.set(job.id, { dir });
    try {
      const ghSocket = socketPath(dir, 'gh');
      const gatewayToken = newRunToken();
      await this.deps.gateway.listen(ghSocket, { jobId: job.id, hireId: job.hireId, threadKey, requestedBy: job.requestedBy, repos: this.deps.repos(job.hireId), token: gatewayToken });
      const mcpToken = this.deps.host.register({
        jobId: job.id,
        hireId: job.hireId,
        servers: {
          approve: broker.handler({ jobId: job.id, hireId: job.hireId, threadKey, scope: job.scope, requestedBy: job.requestedBy }),
          tools: this.deps.tools(job, threadKey),
        },
      });
      return {
        mcpServers: crewMcpServers({ execPath: this.deps.execPath, script: this.deps.relayScript, socket: this.deps.host.socketPath, token: mcpToken }),
        sockets: [ghSocket],
        pathFirst: this.deps.shimDir,
        env: {
          CREW_GH_SOCKET: ghSocket,
          CREW_GH_TOKEN: gatewayToken,
          CREW_NODE: this.deps.execPath,
          CREW_GH_SHIM_JS: path.join(this.deps.shimDir, 'gh-shim.js'),
        },
      };
    } catch (err) {
      this.end(job.id);
      throw err;
    }
  }

  /** Every outcome ends here: the MCP token retired, the listener closed, the directory gone. */
  end(jobId: string): void {
    this.deps.host.unregister(jobId);
    this.deps.gateway.close(jobId);
    const open = this.open.get(jobId);
    if (open) removeRunDir(open.dir, this.deps.fsx);
    this.open.delete(jobId);
  }

  endAll(): void {
    for (const id of [...this.open.keys()]) this.end(id);
  }
}
