import type { ServerWebSocket } from 'bun';
import type { Logger } from './logger';
import type { Repositories } from './repositories';
import { fromBase64, randomToken, verifyEd25519 } from './crypto';
import { buildAgentAuthMessage } from './protocol';

/**
 * Agent-facing WebSocket gateway (M2 scope: presence). A desktop agent connects
 * to `/ws`, proves control of its machine identity by signing a server-issued
 * nonce with its Ed25519 key, and is then marked online. Heartbeats keep
 * `machines.last_seen_at` fresh.
 *
 * M3 extends the authenticated branch to broker E2E ciphertext frames between
 * this agent and a web client. Until then, an authenticated agent socket just
 * maintains presence.
 *
 * Close codes: 4400 malformed · 4401 auth failed · 4404 unknown machine.
 */
export interface AgentSocketData {
  nonce: string;
  authed: boolean;
  machineId: string | null;
}

export interface WsGatewayContext {
  repos: Repositories;
  logger: Logger;
}

/** Per-connection state to attach at upgrade time (`server.upgrade(req, { data })`). */
export function newAgentSocketData(): AgentSocketData {
  return { nonce: randomToken(32), authed: false, machineId: null };
}

export function createAgentGateway(ctx: WsGatewayContext) {
  const { repos, logger } = ctx;

  return {
    open(ws: ServerWebSocket<AgentSocketData>) {
      ws.send(JSON.stringify({ type: 'challenge', nonce: ws.data.nonce }));
    },

    async message(ws: ServerWebSocket<AgentSocketData>, raw: string | Buffer) {
      let msg: { type?: string; ed25519Pub?: string; signature?: string };
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        ws.close(4400, 'malformed message');
        return;
      }

      if (!ws.data.authed) {
        if (msg.type !== 'agent:auth' || typeof msg.ed25519Pub !== 'string' || typeof msg.signature !== 'string') {
          ws.close(4401, 'auth required');
          return;
        }
        const edBytes = fromBase64(msg.ed25519Pub);
        const sigBytes = fromBase64(msg.signature);
        if (!edBytes || !sigBytes) {
          ws.close(4400, 'malformed auth');
          return;
        }
        const ok = await verifyEd25519(edBytes, sigBytes, buildAgentAuthMessage(ws.data.nonce));
        if (!ok) {
          ws.close(4401, 'bad signature');
          return;
        }
        const machine = repos.findMachineByEd25519(edBytes);
        if (!machine) {
          ws.close(4404, 'unknown machine');
          return;
        }
        ws.data.authed = true;
        ws.data.machineId = machine.id;
        repos.touchMachine(machine.id);
        ws.send(JSON.stringify({ type: 'agent:ready', machineId: machine.id }));
        logger.info('agent online', { machineId: machine.id });
        return;
      }

      // Authenticated. M2 only maintains presence.
      if (msg.type === 'ping') {
        if (ws.data.machineId) repos.touchMachine(ws.data.machineId);
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    },

    close(ws: ServerWebSocket<AgentSocketData>) {
      if (ws.data.machineId) logger.info('agent offline', { machineId: ws.data.machineId });
    },
  };
}
