import type { ServerWebSocket } from 'bun';
import type { Logger } from './logger';
import type { Repositories } from './repositories';
import { fromBase64, randomToken, verifyEd25519 } from './crypto';
import { buildAgentAuthMessage } from './protocol';

/**
 * WebSocket gateway.
 *
 * Two kinds of socket connect here:
 *   - **Agents** (desktops) upgrade at `/ws`, prove control of their machine
 *     identity by signing a server nonce with their Ed25519 key, and are then
 *     marked online (M2 presence + heartbeat).
 *   - **Web clients** upgrade at `/ws/client` with a valid session cookie
 *     (authenticated at upgrade time) and open a channel to one of their
 *     machines (M3 brokering).
 *
 * Once a client is paired to an agent, the relay is a **blind router**: it
 * forwards opaque `payload`s between the two by client id and never inspects
 * them. The E2E handshake and terminal frames ride inside those payloads
 * (implemented on the endpoints in later M3 slices) — the relay can't read them.
 *
 * Close codes: 4400 malformed · 4401 auth failed · 4403 forbidden · 4404 unknown.
 */

export interface AgentSocketData {
  role: 'agent';
  nonce: string;
  authed: boolean;
  machineId: string | null;
}

export interface ClientSocketData {
  role: 'client';
  userId: string;
  clientId: string;
  /** Set once the client has opened a channel to a machine. */
  machineId: string | null;
}

export type SocketData = AgentSocketData | ClientSocketData;

export interface WsGatewayContext {
  repos: Repositories;
  logger: Logger;
}

/** Per-connection state for an agent (`server.upgrade(req, { data })`). */
export function newAgentSocketData(): AgentSocketData {
  return { role: 'agent', nonce: randomToken(32), authed: false, machineId: null };
}

/** Per-connection state for an authenticated web client. */
export function newClientSocketData(userId: string): ClientSocketData {
  return { role: 'client', userId, clientId: crypto.randomUUID(), machineId: null };
}

function send(ws: ServerWebSocket<SocketData>, obj: unknown): void {
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj));
}

export function createGateway(ctx: WsGatewayContext) {
  const { repos, logger } = ctx;

  // Live routing tables, one gateway per server.
  const agents = new Map<string, ServerWebSocket<SocketData>>(); // machineId -> agent socket
  const clients = new Map<string, ServerWebSocket<SocketData>>(); // clientId  -> client socket

  return {
    open(ws: ServerWebSocket<SocketData>) {
      if (ws.data.role === 'agent') {
        send(ws, { type: 'challenge', nonce: ws.data.nonce });
      }
      // Clients speak first (client:open), so nothing to send on open.
    },

    async message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        ws.close(4400, 'malformed message');
        return;
      }
      if (ws.data.role === 'agent') return handleAgent(ws, ws.data, msg);
      return handleClient(ws, ws.data, msg);
    },

    close(ws: ServerWebSocket<SocketData>) {
      if (ws.data.role === 'agent') {
        const { machineId } = ws.data;
        if (machineId && agents.get(machineId) === ws) {
          agents.delete(machineId);
          logger.info('agent offline', { machineId });
          // Tell any clients bound to this machine that their agent dropped.
          for (const client of clients.values()) {
            if ((client.data as ClientSocketData).machineId === machineId) send(client, { type: 'agent:offline' });
          }
        }
      } else {
        const { clientId, machineId } = ws.data;
        if (clients.get(clientId) === ws) clients.delete(clientId);
        // Tell the agent this client went away so it can tear down the session.
        if (machineId) {
          const agent = agents.get(machineId);
          if (agent) send(agent, { type: 'client:closed', clientId });
        }
      }
    },
  };

  async function handleAgent(ws: ServerWebSocket<SocketData>, data: AgentSocketData, msg: Record<string, unknown>) {
    if (!data.authed) {
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
      if (!(await verifyEd25519(edBytes, sigBytes, buildAgentAuthMessage(data.nonce)))) {
        ws.close(4401, 'bad signature');
        return;
      }
      const machine = repos.findMachineByEd25519(edBytes);
      if (!machine) {
        ws.close(4404, 'unknown machine');
        return;
      }
      data.authed = true;
      data.machineId = machine.id;
      agents.set(machine.id, ws);
      repos.touchMachine(machine.id);
      send(ws, { type: 'agent:ready', machineId: machine.id });
      logger.info('agent online', { machineId: machine.id });
      return;
    }

    // Authenticated agent.
    if (msg.type === 'ping') {
      if (data.machineId) repos.touchMachine(data.machineId);
      send(ws, { type: 'pong' });
      return;
    }
    // Route an opaque frame back to a specific client.
    if (msg.type === 'to-client' && typeof msg.clientId === 'string') {
      const client = clients.get(msg.clientId);
      if (client) send(client, { type: 'from-agent', payload: msg.payload });
    }
  }

  function handleClient(ws: ServerWebSocket<SocketData>, data: ClientSocketData, msg: Record<string, unknown>) {
    // Open a channel to one of the user's machines.
    if (msg.type === 'client:open' && typeof msg.machineId === 'string') {
      const machine = repos.getMachine(msg.machineId);
      if (!machine || machine.user_id !== data.userId) {
        ws.close(4403, 'not your machine');
        return;
      }
      const agent = agents.get(machine.id);
      if (!agent) {
        send(ws, { type: 'agent:offline' });
        return;
      }
      data.machineId = machine.id;
      clients.set(data.clientId, ws);
      // Hand the agent the new client + whatever opaque handshake payload rode along.
      send(agent, { type: 'client:open', clientId: data.clientId, payload: msg.payload });
      send(ws, { type: 'channel:open', clientId: data.clientId });
      return;
    }
    // Route an opaque frame to this client's agent.
    if (msg.type === 'to-agent' && data.machineId) {
      const agent = agents.get(data.machineId);
      if (agent) send(agent, { type: 'from-client', clientId: data.clientId, payload: msg.payload });
    }
  }
}
