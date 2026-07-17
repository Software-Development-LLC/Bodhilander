/**
 * PWA WebSocket client (BDHLNDR-55).
 *
 * Singleton, app-wide WS connection to the Bodhilander desktop server.
 * Designed to be a foundational module reused by:
 *   - BDHLNDR-55 — session list live refresh (`sessions:updated`, `session:state`)
 *   - BDHLNDR-56 — chat view (`chat:event` per-session subscription)
 *   - BDHLNDR-57 — raw terminal fallback (`terminal:output` / `terminal:exit`)
 *   - BDHLNDR-59 — offline cache replay
 *
 * --------------------------------------------------------------------------
 * Wire contract (locked by BDHLNDR-60 — DO NOT change unilaterally)
 * --------------------------------------------------------------------------
 *  1. Open `wss://${host}/` — the desktop's HTTP server intercepts upgrades
 *     on any path. We use the literal path `/ws` so the vite dev-server
 *     proxy block (`/ws → ws://localhost:8443`) matches in development;
 *     the production server ignores the path.
 *  2. Send `{type: 'auth', token: '<bearer>'}` as the first frame within
 *     5s, or the server closes with 4408.
 *  3. Wait for `{type: 'connected', payload: {deviceId, canControl,
 *     canModify}, timestamp}` ack. Until that arrives, no other frames
 *     are emitted by the client (and the server would close 4401 if we
 *     tried).
 *  4. After the ack, normal message dispatch begins. Server close codes:
 *       4401 — unauthorized (bad token, malformed frame, msg before auth)
 *       4408 — auth timeout
 *
 * --------------------------------------------------------------------------
 * Broadcast model — important distinction
 * --------------------------------------------------------------------------
 *   - **Global broadcasts** (no subscription required, fire after auth):
 *       `sessions:updated`, `session:state`, `groups:updated`, `error`, `pong`
 *   - **Session-scoped** (require explicit `terminal:subscribe`):
 *       `terminal:output`, `terminal:exit`, `chat:event`, `terminal:subscribed`
 *
 *   Call `wsClient.subscribeSession(id)` to receive session-scoped frames
 *   for a given session id. Subscriptions are remembered across reconnects
 *   and re-issued automatically after the next `connected` ack.
 *
 * --------------------------------------------------------------------------
 * Lifecycle & reconnect
 * --------------------------------------------------------------------------
 *   - Lazy: the first `on()`, `send()`, `subscribeSession()`, or explicit
 *     `connect()` triggers the socket open. Status flips through
 *     `idle → connecting → connected` on the happy path.
 *   - Exponential backoff on unexpected close: 1s, 2s, 4s, 8s, 16s, 30s
 *     (capped). Reset to 1s after a successful `connected` ack.
 *   - 4401 / 4408 do NOT trigger reconnect — those mean the token is bad
 *     or the handshake failed structurally; bouncing would just spam. The
 *     consumer (RequireAuth in App.tsx) is expected to re-pair.
 *   - **No idle disconnect.** The PWA is "phone in your pocket": staying
 *     connected lets live updates (`sessions:updated`, `chat:event`) push
 *     instantly without reconnect lag on every navigation. The cost is
 *     one open WS per paired device — acceptable.
 *   - On `disconnect()` (e.g. unpair) the socket closes with 1000 and no
 *     reconnect is attempted.
 *
 * --------------------------------------------------------------------------
 * Public API surface (downstream tickets BDHLNDR-56/57/59 consume this)
 * --------------------------------------------------------------------------
 *   interface WsClient {
 *     readonly status: WsStatus;
 *     onStatusChange(handler: (status: WsStatus) => void): () => void;
 *     connect(): Promise<void>;                  // idempotent; resolves on 'connected'
 *     disconnect(): void;                        // explicit close; no reconnect
 *     on<T extends WsMessageType>(
 *       type: T,
 *       handler: (msg: ServerMessage<T>) => void,
 *     ): () => void;                             // returns unsubscribe
 *     send(msg: ClientMessage): void;            // queued if not yet connected
 *     subscribeSession(sessionId: string): () => void;  // ref-counted
 *   }
 *   export const wsClient: WsClient
 */

import { getAuthToken } from './api';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Status of the underlying socket — surface this in UI for the dot indicator. */
export type WsStatus =
  | 'idle'           // never connected (or disconnect() called)
  | 'connecting'     // socket open, awaiting `connected` ack
  | 'connected'      // handshake complete; messages flowing
  | 'reconnecting'   // backoff between attempts after an unexpected close
  | 'closed';        // terminal: auth rejected or explicit disconnect()

/**
 * Discriminated union of every server → client message type the PWA might
 * receive. Add new types here as they appear server-side (and bump the
 * BDHLNDR ticket comment so future readers know who introduced it).
 */
export type ServerMessage<T extends WsMessageType = WsMessageType> = Extract<
  AnyServerMessage,
  { type: T }
>;

export type WsMessageType = AnyServerMessage['type'];

export type AnyServerMessage =
  | ConnectedMessage
  | SessionsUpdatedMessage
  | GroupsUpdatedMessage
  | SessionStateMessage
  | TerminalOutputMessage
  | TerminalExitMessage
  | TerminalSubscribedMessage
  | ChatEventMessage
  | ErrorMessage
  | PongMessage;

export interface ConnectedMessage {
  type: 'connected';
  payload: { deviceId: string; canControl: boolean; canModify: boolean };
  timestamp: number;
}

export interface SessionsUpdatedMessage {
  type: 'sessions:updated';
  timestamp: number;
}

export interface GroupsUpdatedMessage {
  type: 'groups:updated';
  timestamp: number;
}

export interface SessionStateMessage {
  type: 'session:state';
  sessionId: string;
  payload: { state: string; event?: string };
  timestamp: number;
}

export interface TerminalOutputMessage {
  type: 'terminal:output';
  sessionId: string;
  payload: { data: string };
  timestamp: number;
}

export interface TerminalExitMessage {
  type: 'terminal:exit';
  sessionId: string;
  payload: { exitCode: number };
  timestamp: number;
}

export interface TerminalSubscribedMessage {
  type: 'terminal:subscribed';
  sessionId: string;
  timestamp: number;
}

/**
 * `chat:event` payload is intentionally typed as `unknown` here — the full
 * shape lives in `src/main/api/chat-parser.ts` and changes more often than
 * the PWA needs to track. Consumers (BDHLNDR-56) narrow at use-site.
 */
export interface ChatEventMessage {
  type: 'chat:event';
  sessionId: string;
  payload: unknown;
  timestamp: number;
}

export interface ErrorMessage {
  type: 'error';
  payload: { message: string };
  timestamp: number;
}

export interface PongMessage {
  type: 'pong';
  payload: { clientTimestamp?: number };
  timestamp: number;
}

/** Client → server messages. Server tolerates extra fields; keep these minimal. */
export type ClientMessage =
  | { type: 'ping'; timestamp: number }
  | { type: 'terminal:subscribe'; sessionId: string }
  | { type: 'terminal:unsubscribe'; sessionId: string }
  | { type: 'terminal:input'; sessionId: string; payload: { data: string } }
  | { type: 'terminal:resize'; sessionId: string; payload: { cols: number; rows: number } };

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface WsClient {
  readonly status: WsStatus;
  /** Subscribe to status changes — useful for the connection-dot in the header. */
  onStatusChange(handler: (status: WsStatus) => void): () => void;
  /** Idempotent. Resolves on `connected` ack; rejects on terminal auth failure. */
  connect(): Promise<void>;
  /** Explicit close. No reconnect. Pending subscriptions are dropped. */
  disconnect(): void;
  /** Type-safe message handler. Returns an unsubscribe fn. */
  on<T extends WsMessageType>(
    type: T,
    handler: (msg: ServerMessage<T>) => void,
  ): () => void;
  /** Queue a message — sent immediately if connected, after handshake otherwise. */
  send(msg: ClientMessage): void;
  /**
   * Subscribe to session-scoped frames for `sessionId`. Ref-counted; the
   * server-side `terminal:subscribe` fires only on the first subscriber and
   * `terminal:unsubscribe` only when the last subscriber goes away. Returns
   * an unsubscribe fn.
   */
  subscribeSession(sessionId: string): () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const BACKOFF_SEQUENCE_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const AUTH_TIMEOUT_MS = 5000;

/** Server close codes that mean "do not reconnect" — see ws-server.ts. */
const WS_CLOSE_UNAUTHORIZED = 4401;
const WS_CLOSE_AUTH_TIMEOUT = 4408;

function createWsClient(): WsClient {
  // ---- mutable state ------------------------------------------------------
  let socket: WebSocket | null = null;
  let status: WsStatus = 'idle';
  let backoffIndex = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  let connectPromise: Promise<void> | null = null;
  let connectResolve: (() => void) | null = null;
  let connectReject: ((err: Error) => void) | null = null;

  /** Outbound queue — frames sent before `connected` flush after the ack. */
  const sendQueue: ClientMessage[] = [];

  /** Message-type → handler set. */
  type AnyHandler = (msg: AnyServerMessage) => void;
  const handlers = new Map<WsMessageType, Set<AnyHandler>>();

  /** Status-change subscribers. */
  const statusHandlers = new Set<(s: WsStatus) => void>();

  /** Ref-counted session subscriptions. */
  const sessionRefCounts = new Map<string, number>();

  // ---- helpers ------------------------------------------------------------

  function setStatus(next: WsStatus): void {
    if (status === next) return;
    status = next;
    for (const h of statusHandlers) {
      try {
        h(next);
      } catch (err) {
        console.error('[ws] status handler threw', err);
      }
    }
  }

  function buildUrl(): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Path `/ws` is a sentinel: the desktop accepts any upgrade path, but the
    // vite dev-server proxy only matches `/ws`. See vite.config.ts.
    return `${proto}//${window.location.host}/ws`;
  }

  function dispatch(msg: AnyServerMessage): void {
    const set = handlers.get(msg.type);
    if (!set) return;
    for (const h of set) {
      try {
        h(msg);
      } catch (err) {
        console.error(`[ws] handler for ${msg.type} threw`, err);
      }
    }
  }

  function flushQueue(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (sendQueue.length > 0) {
      const msg = sendQueue.shift()!;
      socket.send(JSON.stringify(msg));
    }
  }

  function clearAuthTimer(): void {
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * Re-subscribe every session we previously subscribed to. Called after the
   * `connected` ack on a reconnect so consumers don't have to re-register.
   */
  function resubscribeSessions(): void {
    for (const sessionId of sessionRefCounts.keys()) {
      socket?.send(
        JSON.stringify({ type: 'terminal:subscribe', sessionId } satisfies ClientMessage),
      );
    }
  }

  function scheduleReconnect(): void {
    clearReconnectTimer();
    const delay = BACKOFF_SEQUENCE_MS[Math.min(backoffIndex, BACKOFF_SEQUENCE_MS.length - 1)];
    backoffIndex = Math.min(backoffIndex + 1, BACKOFF_SEQUENCE_MS.length - 1);
    setStatus('reconnecting');
    reconnectTimer = setTimeout(() => {
      void openSocket();
    }, delay);
  }

  async function openSocket(): Promise<void> {
    clearReconnectTimer();

    const token = await getAuthToken();
    if (!token) {
      // No auth — nothing to do. Caller (RequireAuth) has bounced to /pair.
      setStatus('closed');
      const err = new Error('No auth token available');
      connectReject?.(err);
      connectPromise = null;
      connectResolve = null;
      connectReject = null;
      return;
    }

    setStatus('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(buildUrl());
    } catch (err) {
      console.error('[ws] failed to open socket', err);
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      // Step 1: send auth as the first frame.
      ws.send(JSON.stringify({ type: 'auth', token }));
      // Step 2: arm a guard so we don't sit forever in `connecting` if the
      // server never acks. Server-side limit is 5s; we mirror it client-side.
      clearAuthTimer();
      authTimer = setTimeout(() => {
        console.warn('[ws] auth ack timeout — closing');
        try {
          ws.close(1000, 'auth ack timeout');
        } catch {
          // swallow
        }
      }, AUTH_TIMEOUT_MS);
    };

    ws.onmessage = (event) => {
      let msg: AnyServerMessage;
      try {
        msg = JSON.parse(event.data as string) as AnyServerMessage;
      } catch (err) {
        console.error('[ws] failed to parse frame', err);
        return;
      }

      if (msg.type === 'connected') {
        clearAuthTimer();
        backoffIndex = 0;
        setStatus('connected');
        resubscribeSessions();
        flushQueue();
        connectResolve?.();
        connectPromise = null;
        connectResolve = null;
        connectReject = null;
      }

      dispatch(msg);
    };

    ws.onerror = (event) => {
      // Browser hides details for security; surface what we can.
      console.warn('[ws] socket error', event);
    };

    ws.onclose = (event) => {
      clearAuthTimer();
      socket = null;

      // Terminal: bad token or auth handshake failure — bail without retry.
      if (event.code === WS_CLOSE_UNAUTHORIZED || event.code === WS_CLOSE_AUTH_TIMEOUT) {
        console.warn(`[ws] terminal close ${event.code}: ${event.reason}`);
        setStatus('closed');
        connectReject?.(new Error(`WS closed (${event.code}): ${event.reason}`));
        connectPromise = null;
        connectResolve = null;
        connectReject = null;
        return;
      }

      // Explicit local disconnect — already in `closed`, do nothing.
      if (status === 'closed') {
        return;
      }

      // Anything else (network blip, server restart, etc.) → backoff & retry.
      console.info(`[ws] close ${event.code} ${event.reason} — scheduling reconnect`);
      scheduleReconnect();
    };
  }

  // ---- public API ---------------------------------------------------------

  const client: WsClient = {
    get status() {
      return status;
    },

    onStatusChange(handler) {
      statusHandlers.add(handler);
      // Fire once with current state so subscribers can render correctly on mount.
      try {
        handler(status);
      } catch (err) {
        console.error('[ws] initial status handler threw', err);
      }
      return () => {
        statusHandlers.delete(handler);
      };
    },

    connect() {
      if (status === 'connected') {
        return Promise.resolve();
      }
      if (connectPromise) {
        return connectPromise;
      }
      connectPromise = new Promise<void>((resolve, reject) => {
        connectResolve = resolve;
        connectReject = reject;
      });
      // If we were in `closed` from an earlier disconnect, treat connect()
      // as a fresh start.
      if (status === 'closed') {
        backoffIndex = 0;
      }
      void openSocket();
      return connectPromise;
    },

    disconnect() {
      clearReconnectTimer();
      clearAuthTimer();
      setStatus('closed');
      sendQueue.length = 0;
      sessionRefCounts.clear();
      if (socket) {
        try {
          socket.close(1000, 'client disconnect');
        } catch {
          // swallow
        }
        socket = null;
      }
      if (connectReject) {
        connectReject(new Error('disconnected'));
      }
      connectPromise = null;
      connectResolve = null;
      connectReject = null;
    },

    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler as AnyHandler);
      // Lazy connect: first subscriber triggers the socket. Errors are
      // swallowed here — the consumer can observe via onStatusChange().
      if (status === 'idle' || status === 'closed') {
        void client.connect().catch(() => {
          // already logged inside openSocket / onclose
        });
      }
      return () => {
        set.delete(handler as AnyHandler);
        if (set.size === 0) {
          handlers.delete(type);
        }
      };
    },

    send(msg) {
      // Always queue; flushQueue handles the "already connected" fast path.
      sendQueue.push(msg);
      if (status === 'idle' || status === 'closed') {
        void client.connect().catch(() => {
          // see on() above
        });
        return;
      }
      if (status === 'connected') {
        flushQueue();
      }
      // For 'connecting' / 'reconnecting' the queue flushes on the next
      // 'connected' ack.
    },

    subscribeSession(sessionId) {
      const prev = sessionRefCounts.get(sessionId) ?? 0;
      sessionRefCounts.set(sessionId, prev + 1);
      if (prev === 0) {
        client.send({ type: 'terminal:subscribe', sessionId });
      }
      return () => {
        const current = sessionRefCounts.get(sessionId) ?? 0;
        if (current <= 1) {
          sessionRefCounts.delete(sessionId);
          // Only send unsubscribe if we have a live socket — on a closed
          // socket the server-side state is already gone.
          if (status === 'connected') {
            client.send({ type: 'terminal:unsubscribe', sessionId });
          }
        } else {
          sessionRefCounts.set(sessionId, current - 1);
        }
      };
    },
  };

  return client;
}

export const wsClient: WsClient = createWsClient();
