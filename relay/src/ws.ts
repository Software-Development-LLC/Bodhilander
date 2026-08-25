import type { ServerWebSocket } from 'bun';
import type { Logger } from './logger';
import type { Machine, MachineGrant, Repositories } from './repositories';
import { fromBase64, randomToken, verifyEd25519 } from './crypto';
import { buildAgentAuthMessage, CAP_GRANTS_V1, CAP_PUSH_V1 } from './protocol';
import type { RateLimiter } from './rate-limit';
import type { PushDispatcher } from './push/send';

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
  /**
   * Sends a sealed push body to a push service. Absent means push is not
   * configured on this relay, and `push:send` is dropped rather than queued.
   */
  push?: PushDispatcher;
  /** Shared with the HTTP router, so `push:send` is bounded like a route is. */
  rateLimiter?: RateLimiter;
}

/** How long an agent socket may sit unauthenticated before it is closed. */
export const AGENT_AUTH_TIMEOUT_MS = 30_000;

/**
 * Ceiling on one `push:send`. A fan-out is bounded by the owner's device count
 * (`MAX_PUSH_SUBSCRIPTIONS_PER_USER`), so anything larger is not a fan-out.
 */
export const MAX_PUSH_ITEMS = 32;

/**
 * Largest sealed body the relay will forward, base64. Push services cap a
 * payload at 4096 octets and base64 adds a third; anything past this would be
 * refused downstream anyway, so refusing it here keeps it off the wire.
 */
export const MAX_SEALED_BODY_B64 = 6144;

/** Sends one machine's agent may make per minute, across every subscription. */
export const PUSH_SENDS_PER_MINUTE = 30;

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
    /** HTTP-side seam: this user subscribed or unsubscribed a browser. */
    notifyPushSubscriptions,
    /** HTTP-side seam: can this machine's live agent seal push payloads? */
    isPushCapable,

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
    if (!data.authed) return authenticateAgent(ws, data, msg);

    // Authenticated agent.
    if (msg.type === 'ping') {
      if (data.machineId) repos.touchMachine(data.machineId);
      send(ws, { type: 'pong' });
      return;
    }
    if (msg.type === 'to-client' && typeof msg.clientId === 'string') {
      const client = ownClient(msg.clientId, data.machineId);
      if (client) send(client, { type: 'from-agent', payload: msg.payload });
      return;
    }

    if (!data.machineId) return;
    if (handleAgentShare(data.machineId, msg)) return;

    // Sealed push payloads, one per subscription, for the relay to address and
    // forward. The relay cannot read them; see `handlePushSend`.
    if (msg.type === 'push:send' && Array.isArray(msg.items)) {
      handlePushSend(ws, data.machineId, msg.items);
      return;
    }

    // Cut one live client without revoking its grant — used for pause and for
    // ending a session the guest was watching.
    if (msg.type === 'client:kick' && typeof msg.clientId === 'string') {
      ownClient(msg.clientId, data.machineId)?.close(4403, typeof msg.reason === 'string' ? msg.reason : 'ended');
    }
  }

  /**
   * A live client socket, but only if bound to `machineId`. Without this an
   * agent could name any client id and reach into someone else's channel.
   */
  function ownClient(clientId: string, machineId: string | null): ServerWebSocket<SocketData> | null {
    const client = clients.get(clientId);
    if (!client || (client.data as ClientSocketData).machineId !== machineId) return null;
    return client;
  }

  /** Prove which machine is speaking, then publish the socket and sync it. */
  async function authenticateAgent(
    ws: ServerWebSocket<SocketData>,
    data: AgentSocketData,
    msg: Record<string, unknown>,
  ) {
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
    // Advertised capabilities. Only strings, and only after the signature has
    // proven who is speaking — an unauthenticated socket must not be able to
    // claim `grants:v1` for a machine it does not control.
    const caps = Array.isArray(msg.caps) ? msg.caps.filter((c): c is string => typeof c === 'string') : [];
    publishAgent(ws, data, machine, caps);
  }

  /** Adopt a proven agent socket as the live one for its machine, and sync it. */
  function publishAgent(
    ws: ServerWebSocket<SocketData>,
    data: AgentSocketData,
    machine: Machine,
    caps: string[],
  ): void {
    data.authed = true;
    data.machineId = machine.id;
    data.caps = caps;
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
    // The agent seals every push payload itself, so it needs the owner's
    // subscription keys before it can send anything. Handed over on connect
    // and refreshed whenever the set changes — the agent never asks.
    sendPushSync(ws, machine.user_id);
    logger.info('agent online', { machineId: machine.id });
  }

  /**
   * The desktop's half of the sharing protocol. Reports whether the message was
   * one of these, so the caller can carry on looking if it was not.
   */
  function handleAgentShare(machineId: string, msg: Record<string, unknown>): boolean {
    // The owner approved: attach the countersigned certificate. Scoped to this
    // agent's own machine, so an agent cannot bind a grant on someone else's.
    if (msg.type === 'share:bind' && typeof msg.grantId === 'string' && typeof msg.certificate === 'string') {
      const grant = repos.getGrant(msg.grantId);
      if (!grant || grant.machine_id !== machineId) return true;
      const expiresAt = typeof msg.expiresAt === 'number' ? msg.expiresAt : 0;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return true;
      if (repos.bindGrantCertificate(msg.grantId, msg.certificate, expiresAt)) {
        logger.info('grant bound', { machineId, grantId: msg.grantId });
      }
      return true;
    }

    // The owner said no, or the machine cannot honour it.
    if (msg.type === 'share:deny' && typeof msg.grantId === 'string') {
      const grant = repos.getGrant(msg.grantId);
      if (!grant || grant.machine_id !== machineId) return true;
      repos.revokeGrant(msg.grantId);
      kickGrant(msg.grantId, typeof msg.reason === 'string' ? msg.reason : 'denied');
      logger.info('grant denied', { machineId, grantId: msg.grantId });
      return true;
    }

    // The desktop is the authority on revocation, so its list wins. Anything
    // the relay still holds for this machine that the agent does not name is a
    // ghost — from a relay restore, or a revocation queued while offline.
    if (msg.type === 'share:reconcile' && Array.isArray(msg.activeGrantIds)) {
      const live = new Set(msg.activeGrantIds.filter((id): id is string => typeof id === 'string'));
      let dropped = 0;
      for (const grant of repos.listGrantsForMachine(machineId)) {
        if (live.has(grant.id)) continue;
        repos.revokeGrant(grant.id);
        kickGrant(grant.id, 'revoked');
        dropped += 1;
      }
      if (dropped > 0) logger.info('reconciled away stale grants', { machineId, dropped });
      return true;
    }
    return false;
  }


  /** Tell an agent about every grant the relay currently holds for its machine. */
  function sendShareSync(agent: ServerWebSocket<SocketData>, machineId: string): void {
    send(agent, { type: 'share:sync', grants: repos.listGrantsForMachine(machineId).map(wireGrant) });
  }

  /**
   * Hand an agent the keys it seals push payloads to. The ENDPOINT is withheld:
   * the agent encrypts, the relay addresses, so the desktop never learns which
   * push service its owner reads on. Minimal disclosure, pointed both ways.
   */
  function sendPushSync(agent: ServerWebSocket<SocketData>, userId: string): void {
    if (!agentSupportsPush(agent)) return;
    send(agent, {
      type: 'push:sync',
      subs: repos.listPushSubscriptions(userId).map((s) => ({ id: s.id, p256dh: s.p256dh, auth: s.auth })),
    });
  }

  /**
   * A user's subscriptions changed — re-sync every machine they own that is
   * online. Called from the HTTP routes and after a reap.
   */
  function notifyPushSubscriptions(userId: string): void {
    for (const machine of repos.listMachines(userId)) {
      const agent = agents.get(machine.id);
      if (agent) sendPushSync(agent, userId);
    }
  }

  /**
   * Forward sealed payloads from one machine's agent. Checked: each named
   * subscription belongs to this socket's machine owner. Not checked: the
   * contents, which is the point. A 404/410 is reaped here.
   */
  function handlePushSend(ws: ServerWebSocket<SocketData>, machineId: string | null, items: unknown[]): void {
    if (!machineId || !ctx.push) return;
    const machine = repos.getMachine(machineId);
    if (!machine) return;

    if (ctx.rateLimiter) {
      const verdict = ctx.rateLimiter.check(`push:machine:${machineId}`, PUSH_SENDS_PER_MINUTE, 60_000);
      if (!verdict.allowed) {
        // Refused OUT LOUD. Dropping it silently spent the agent's debounce on
        // a notification that never left the building, so those sessions would
        // stay quiet until their next state change — a fleet restart losing
        // alerts with no signal at either end.
        logger.warn('rate limited push:send', { machineId });
        send(ws, { type: 'push:throttled', retryAfterSeconds: verdict.retryAfter });
        return;
      }
    }

    void deliverPushItems(machine.user_id, items.slice(0, MAX_PUSH_ITEMS));
  }

  async function deliverPushItems(userId: string, items: unknown[]): Promise<void> {
    const dispatcher = ctx.push;
    if (!dispatcher) return;
    let reaped = false;
    // One delivery per subscription per message. Repeated ids would otherwise
    // turn a single batch into that many POSTs at one chosen target.
    const seen = new Set<string>();

    for (const raw of items) {
      const item = raw as { id?: unknown; body?: unknown };
      if (typeof item.id !== 'string' || typeof item.body !== 'string') continue;
      if (item.body.length > MAX_SEALED_BODY_B64) {
        logger.warn('dropped an oversized sealed push body', { userId });
        continue;
      }
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const sub = repos.getPushSubscription(item.id);
      // Belongs to someone else, or was removed while the agent was sealing.
      // Either way this agent may not send to it.
      if (!sub || sub.user_id !== userId) continue;

      const body = fromBase64(item.body);
      if (!body || body.length === 0) continue;

      try {
        const result = await dispatcher.deliver(sub.endpoint, body);
        if (result.gone) {
          repos.deletePushSubscription(sub.id);
          reaped = true;
          logger.info('reaped a dead push subscription', { userId, status: result.status });
        } else if (result.redirected) {
          // Never followed: see `deliver`. Logged loudly because a push service
          // that redirects is either broken or not a push service.
          logger.warn('refused to follow a push endpoint redirect', { status: result.status });
        } else if (result.status !== null && result.status >= 400) {
          // Transient from here: a 429 or a 5xx is the push service's problem
          // and the next attention event retries on its own.
          logger.warn('push service refused a message', { status: result.status });
        }
      } catch (err) {
        logger.warn('push delivery failed', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    // Only after the whole batch: re-syncing per reap would send the agent a
    // list it is still working through.
    if (reaped) notifyPushSubscriptions(userId);
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

  /** Whether this agent build can seal push payloads — see `CAP_PUSH_V1`. */
  function agentSupportsPush(agent: ServerWebSocket<SocketData>): boolean {
    const data = agent.data;
    return data.role === 'agent' && data.caps.includes(CAP_PUSH_V1);
  }

  /**
   * What the live agent for `machineId` said about push, or null when none is
   * connected. Null is "we do not know", which the client must not render as a
   * problem — an offline machine is a different sentence.
   */
  function isPushCapable(machineId: string): boolean | null {
    const agent = agents.get(machineId);
    return agent ? agentSupportsPush(agent) : null;
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
      openClientChannel(ws, data, msg.machineId, msg.payload);
      return;
    }
    // Route an opaque frame to this client's agent.
    if (msg.type === 'to-agent' && data.machineId) {
      const agent = agents.get(data.machineId);
      if (agent) send(agent, { type: 'from-client', clientId: data.clientId, payload: msg.payload });
    }
  }

  /** Bind one client socket to a machine and introduce it to that agent. */
  function openClientChannel(
    ws: ServerWebSocket<SocketData>,
    data: ClientSocketData,
    machineId: string,
    payload: unknown,
  ): void {
    // One channel per socket. Re-opening would strand the agent's state for
    // this client id and could re-point the socket at a different machine.
    if (data.machineId) {
      ws.close(4400, 'channel already open');
      return;
    }
    const access = repos.getMachineAccess(machineId, data.userId);
    if (access.relation === 'none') {
      // A former guest is told which ending their access met — anything
      // else sends their client into a silent reconnect loop against a
      // dead grant. A stranger still gets the unrevealing answer.
      ws.close(4403, repos.endedGrantReason(machineId, data.userId) ?? 'not your machine');
      return;
    }
    const machine = access.machine;
    const agent = agents.get(machine.id);
    if (!agent) {
      send(ws, { type: 'agent:offline' });
      return;
    }

    // Version skew is a hard requirement, not an open question. A build that
    // predates grant enforcement reads only `clientX25519Pub` and ignores the
    // rest, so handing it a guest would grant that guest every command on a
    // machine whose owner never opted into sharing. The relay redeploys
    // independently of shipped Electron builds; refuse instead.
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
    // `principal` is relay-ASSERTED, and named so no branch downstream reads it
    // as authorization. The agent treats it as a claim to check a certificate
    // against, never as a grant in itself.
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
      payload,
    });
    send(ws, { type: 'channel:open', clientId: data.clientId });
  }
}
