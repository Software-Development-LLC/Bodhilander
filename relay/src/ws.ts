import type { ServerWebSocket } from 'bun';
import type { Logger } from './logger';
import type { MachineGrant, Repositories } from './repositories';
import { fromBase64, randomToken, verifyEd25519 } from './crypto';
import { buildAgentAuthMessage, CAP_GRANTS_V1 } from './protocol';

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
  /** Reaper for a socket that connects but never answers the challenge. */
  authTimer: ReturnType<typeof setTimeout> | null;
  /**
   * What this agent build says it understands, from `agent:auth`. Empty for
   * any build that predates capability advertisement — which is the case this
   * exists to handle.
   */
  caps: readonly string[];
}

export interface ClientSocketData {
  role: 'client';
  userId: string;
  clientId: string;
  /** Set once the client has opened a channel to a machine. */
  machineId: string | null;
  /**
   * The grant this socket connected under, for guests. Null for the owner.
   * Recorded so a revocation can find and cut the live socket rather than
   * waiting for the guest to reconnect.
   */
  grantId: string | null;
}

export type SocketData = AgentSocketData | ClientSocketData;

export interface WsGatewayContext {
  repos: Repositories;
  logger: Logger;
  /**
   * Override the unauthenticated-agent reaper. Defaults to
   * `AGENT_AUTH_TIMEOUT_MS`; tests shorten it so the close path can be
   * asserted rather than only the timer plumbing.
   */
  authTimeoutMs?: number;
}

/** How long an agent socket may sit unauthenticated before it is closed. */
export const AGENT_AUTH_TIMEOUT_MS = 30_000;

/** Per-connection state for an agent (`server.upgrade(req, { data })`). */
export function newAgentSocketData(): AgentSocketData {
  return { role: 'agent', nonce: randomToken(32), authed: false, machineId: null, authTimer: null, caps: [] };
}

/** Per-connection state for an authenticated web client. */
export function newClientSocketData(userId: string): ClientSocketData {
  return { role: 'client', userId, clientId: crypto.randomUUID(), machineId: null, grantId: null };
}

function send(ws: ServerWebSocket<SocketData>, obj: unknown): void {
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj));
}

export function createGateway(ctx: WsGatewayContext) {
  const { repos, logger } = ctx;
  const authTimeoutMs = ctx.authTimeoutMs ?? AGENT_AUTH_TIMEOUT_MS;

  // Live routing tables, one gateway per server.
  const agents = new Map<string, ServerWebSocket<SocketData>>(); // machineId -> agent socket
  const clients = new Map<string, ServerWebSocket<SocketData>>(); // clientId  -> client socket

  return {
    open(ws: ServerWebSocket<SocketData>) {
      if (ws.data.role === 'agent') {
        const data = ws.data;
        send(ws, { type: 'challenge', nonce: data.nonce });
        // Don't let an unauthenticated socket linger: it costs a connection
        // slot and nothing can ever be routed over it.
        data.authTimer = setTimeout(() => {
          data.authTimer = null;
          if (!data.authed) ws.close(4401, 'auth timeout');
        }, authTimeoutMs);
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

    /** HTTP-side seams: a guest redeemed, or a grant was revoked over REST. */
    notifyGrantRedeemed,
    notifyGrantRevoked,

    close(ws: ServerWebSocket<SocketData>) {
      if (ws.data.role === 'agent') {
        const { machineId, authTimer } = ws.data;
        if (authTimer) {
          clearTimeout(authTimer);
          ws.data.authTimer = null;
        }
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
      // Advertised capabilities. Only strings, and only after the signature
      // has proven who is speaking — an unauthenticated socket must not be
      // able to claim `grants:v1` for a machine it does not control.
      data.caps = Array.isArray(msg.caps) ? msg.caps.filter((c): c is string => typeof c === 'string') : [];
      if (data.authTimer) {
        clearTimeout(data.authTimer);
        data.authTimer = null;
      }
      // One live socket per machine. Publish the new socket BEFORE closing the
      // old one: the close handler only touches `agents` when the map still
      // points at the socket that closed, so this ordering guarantees it can't
      // delete the live entry or announce a spurious `agent:offline` to clients.
      const previous = agents.get(machine.id);
      agents.set(machine.id, ws);
      if (previous && previous !== ws) {
        logger.info('replacing an existing agent socket', { machineId: machine.id });
        previous.close(4409, 'replaced by a newer connection');
      }
      repos.touchMachine(machine.id);
      // Who the relay says owns this machine. The desktop cannot learn its own
      // relay user id from anywhere else, and this is an ASSERTION, not proof:
      // a human confirms it once (design §3), because minting owner capability
      // for whatever id an untrusted party named would hand the relay the keys.
      const owner = repos.getUser(machine.user_id);
      send(ws, {
        type: 'agent:ready',
        machineId: machine.id,
        owner: owner
          ? { userId: owner.id, displayName: owner.display_name, email: owner.primary_email }
          : null,
      });
      // Close the split-brain on every reconnect: the relay holds certificates
      // and routes, the desktop holds the session lists and revocation status.
      // Without this a relay volume loss leaves ghosts in the owner's settings,
      // and a desktop reinstall leaves guests connecting to a DENY_ALL with no
      // explanation.
      sendShareSync(ws, machine.id);
      logger.info('agent online', { machineId: machine.id });
      return;
    }

    // Authenticated agent.
    if (msg.type === 'ping') {
      if (data.machineId) repos.touchMachine(data.machineId);
      send(ws, { type: 'pong' });
      return;
    }
    // Route an opaque frame back to a specific client. The target must be bound
    // to THIS agent's machine — without that check an agent could name any
    // client id in the table and inject frames into someone else's channel.
    if (msg.type === 'to-client' && typeof msg.clientId === 'string') {
      const client = clients.get(msg.clientId);
      if (client && (client.data as ClientSocketData).machineId === data.machineId) {
        send(client, { type: 'from-agent', payload: msg.payload });
      }
      return;
    }

    if (!data.machineId) return;

    // The owner approved: attach the countersigned certificate. Scoped to this
    // agent's own machine, so an agent cannot bind a grant on someone else's.
    if (msg.type === 'share:bind' && typeof msg.grantId === 'string' && typeof msg.certificate === 'string') {
      const grant = repos.getGrant(msg.grantId);
      if (!grant || grant.machine_id !== data.machineId) return;
      const expiresAt = typeof msg.expiresAt === 'number' ? msg.expiresAt : 0;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return;
      if (repos.bindGrantCertificate(msg.grantId, msg.certificate, expiresAt)) {
        logger.info('grant bound', { machineId: data.machineId, grantId: msg.grantId });
      }
      return;
    }

    // The owner said no, or the machine cannot honour it.
    if (msg.type === 'share:deny' && typeof msg.grantId === 'string') {
      const grant = repos.getGrant(msg.grantId);
      if (!grant || grant.machine_id !== data.machineId) return;
      repos.revokeGrant(msg.grantId);
      kickGrant(msg.grantId, typeof msg.reason === 'string' ? msg.reason : 'denied');
      logger.info('grant denied', { machineId: data.machineId, grantId: msg.grantId });
      return;
    }

    // The desktop is the authority on revocation, so its list wins. Anything
    // the relay still holds for this machine that the agent does not name is a
    // ghost — from a relay restore, or a revocation queued while offline.
    if (msg.type === 'share:reconcile' && Array.isArray(msg.activeGrantIds)) {
      const live = new Set(msg.activeGrantIds.filter((id): id is string => typeof id === 'string'));
      let dropped = 0;
      for (const grant of repos.listGrantsForMachine(data.machineId)) {
        if (live.has(grant.id)) continue;
        repos.revokeGrant(grant.id);
        kickGrant(grant.id, 'revoked');
        dropped += 1;
      }
      if (dropped > 0) logger.info('reconciled away stale grants', { machineId: data.machineId, dropped });
      return;
    }

    // Cut one live client without revoking its grant — used for pause and for
    // ending a session the guest was watching.
    if (msg.type === 'client:kick' && typeof msg.clientId === 'string') {
      const client = clients.get(msg.clientId);
      if (client && (client.data as ClientSocketData).machineId === data.machineId) {
        client.close(4403, typeof msg.reason === 'string' ? msg.reason : 'ended');
      }
    }
  }

  /** Tell an agent about every grant the relay currently holds for its machine. */
  function sendShareSync(agent: ServerWebSocket<SocketData>, machineId: string): void {
    send(agent, { type: 'share:sync', grants: repos.listGrantsForMachine(machineId).map(wireGrant) });
  }

  /**
   * A guest redeemed an invite. Wake the owner's agent if it is online; if it
   * is not, `share:sync` on its next `agent:ready` carries the same pending
   * grant, so nothing is lost by the owner being away.
   */
  function notifyGrantRedeemed(grant: MachineGrant): void {
    const agent = agents.get(grant.machine_id);
    if (!agent) return;
    send(agent, { type: 'share:pending', grants: [wireGrant(grant)] });
  }

  /** A grant was revoked over HTTP — tell the agent and cut any live socket. */
  function notifyGrantRevoked(grant: MachineGrant): void {
    const agent = agents.get(grant.machine_id);
    if (agent) send(agent, { type: 'grant:revoked', grantId: grant.id });
    kickGrant(grant.id, 'revoked');
  }

  /** Close every client socket connected under `grantId`. */
  function kickGrant(grantId: string, reason: string): void {
    for (const client of clients.values()) {
      if ((client.data as ClientSocketData).grantId === grantId) client.close(4403, reason);
    }
  }

  /**
   * A grant as the agent needs to see it. The certificate is omitted — the
   * agent signed it and does not need it back, and echoing it would put a
   * credential on a wire that does not need to carry one.
   */
  function wireGrant(g: MachineGrant) {
    const grantee = repos.getUser(g.grantee_user_id);
    return {
      grantId: g.id,
      status: g.status,
      role: g.role,
      label: g.label,
      granteeUserId: g.grantee_user_id,
      granteeLogin: grantee?.github_login ?? null,
      granteeName: grantee?.display_name ?? null,
      // So the desktop can recover which session it offered — the relay never
      // learns that, by design.
      inviteId: g.invite_id,
      createdAt: g.created_at,
      expiresAt: g.expires_at,
      // What the invite promised. `expires_at` is NULL until we countersign,
      // so this is the only thing the agent can size a certificate from at the
      // moment the owner approves.
      grantTtlSeconds: g.grant_ttl_seconds,
    };
  }

  /** Whether the live agent socket for a machine enforces grant certificates. */
  function agentSupportsGrants(agent: ServerWebSocket<SocketData>): boolean {
    const data = agent.data;
    return data.role === 'agent' && data.caps.includes(CAP_GRANTS_V1);
  }

  function handleClient(ws: ServerWebSocket<SocketData>, data: ClientSocketData, msg: Record<string, unknown>) {
    // Browser keepalive. Browsers can't send WS control frames from script, so
    // an idle viewer looks dead to any intermediary; the client pings instead.
    if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }
    // Open a channel to one of the user's machines.
    if (msg.type === 'client:open' && typeof msg.machineId === 'string') {
      // One channel per socket. Re-opening would strand the agent's state for
      // this client id and could re-point the socket at a different machine.
      if (data.machineId) {
        ws.close(4400, 'channel already open');
        return;
      }
      const access = repos.getMachineAccess(msg.machineId, data.userId);
      if (access.relation === 'none') {
        // A former guest is told which ending their access met — anything
        // else sends their client into a silent reconnect loop against a
        // dead grant. A stranger still gets the unrevealing answer.
        ws.close(4403, repos.endedGrantReason(msg.machineId, data.userId) ?? 'not your machine');
        return;
      }
      const machine = access.machine;
      const agent = agents.get(machine.id);
      if (!agent) {
        send(ws, { type: 'agent:offline' });
        return;
      }

      // Version skew is a hard requirement, not an open question. A desktop
      // build that predates grant enforcement reads only `clientX25519Pub`
      // from this payload and ignores everything else — so handing it a guest
      // would grant that guest every command, on a machine whose owner never
      // opted into sharing. The relay redeploys independently of shipped
      // Electron builds, so this will genuinely happen; refuse instead.
      if (access.relation === 'grantee' && !agentSupportsGrants(agent)) {
        logger.warn('refusing a guest channel to an agent without grant support', { machineId: machine.id });
        send(ws, { type: 'share:unsupported' });
        return;
      }

      data.machineId = machine.id;
      // Remember which grant let this socket in, so a revocation can cut it
      // immediately instead of waiting for the guest to reconnect.
      data.grantId = access.relation === 'grantee' ? access.grant.id : null;
      if (access.relation === 'grantee') repos.touchGrant(access.grant.id);
      clients.set(data.clientId, ws);
      const principalUser = repos.getUser(data.userId);
      // `principal` is relay-ASSERTED, and named so no branch downstream reads
      // it as authorization. The agent treats it as a claim to check a
      // certificate against, never as a grant in itself.
      //
      // `userId` only, for now: the GitHub login is fetched during OAuth and
      // discarded (`displayName` prefers the profile name), so persisting it
      // needs a column and an auth change. That lands with M5.2, alongside the
      // approval modal and addressed invites that actually read it — a field
      // that is always null now would just invite a downstream branch that
      // never fires.
      send(agent, {
        type: 'client:open',
        clientId: data.clientId,
        principal: {
          userId: data.userId,
          // The handle is what the approval prompt and the presence surfaces
          // show. A display name is free text the account holder chooses, so
          // it is carried only as a secondary label, never as the identity.
          githubLogin: principalUser?.github_login ?? null,
          displayName: principalUser?.display_name ?? null,
        },
        payload: msg.payload,
      });
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
