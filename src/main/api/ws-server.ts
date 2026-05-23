/**
 * WebSocket Server
 *
 * Handles real-time terminal streaming and session state updates.
 *
 * Authentication (BDHLNDR-60): the WS upgrade is accepted unconditionally
 * (subject to the same host/origin checks the HTTP layer enforces). The
 * client MUST send `{type: 'auth', token: '<bearer>'}` as the very first
 * message within AUTH_TIMEOUT_MS or the server closes the connection.
 *
 * Close codes used during auth (outside the 1000–4999 application range
 * reserved by RFC 6455 §7.4.2):
 *   4401 — unauthorized (bad token, malformed first frame, or non-auth
 *          message before auth)
 *   4408 — auth timeout (no message arrived within AUTH_TIMEOUT_MS)
 *
 * On success the server replies with the existing `connected` welcome
 * frame and normal message handling (terminal:subscribe etc.) begins.
 *
 * Wire shape — DO NOT change without coordinating with PWA / mobile
 * clients (BDHLNDR-55, BDHLNDR-56):
 *   client → server: {"type":"auth","token":"<bearer>"}
 *   server → client: {"type":"connected","payload":{"deviceId":"...",
 *                     "canControl":true,"canModify":false},
 *                     "timestamp":<ms>}
 *
 * Replaces the prior `?token=…` URL-query-string scheme (BDHLNDR-11),
 * which leaked the bearer token into any URL-style log between the
 * client and the server (proxies, CDNs, browser history).
 */

import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import log from 'electron-log';
import { PairingManager, PairedDevice } from './pairing/pairing-manager';
import { ptyManager } from '../pty-manager';

export interface WsMessage {
  type: string;
  sessionId?: string;
  payload?: unknown;
  timestamp: number;
}

interface ClientInfo {
  device: PairedDevice;
  subscribedSessions: Set<string>;
}

interface PendingAuth {
  timeout: NodeJS.Timeout;
}

export interface WsServer {
  broadcast(message: WsMessage): void;
  broadcastToSession(sessionId: string, message: WsMessage): void;
  /**
   * Close (with code 4401) any open connections owned by `deviceId`. Called
   * after a device is unpaired (BDHLNDR-67) so the WS connection doesn't
   * outlive the device row server-side.
   */
  closeConnectionsForDevice(deviceId: string): void;
  getClientCount(): number;
  close(): void;
}

/** Max time (ms) a connection may stay in the pending-auth state. */
const AUTH_TIMEOUT_MS = 5000;

/** WebSocket close codes for the auth handshake (RFC 6455 application range). */
const WS_CLOSE_UNAUTHORIZED = 4401;
const WS_CLOSE_AUTH_TIMEOUT = 4408;

/**
 * Create WebSocket server attached to HTTP server
 */
export function createWsServer(httpServer: HttpServer, pairingManager: PairingManager): WsServer {
  const wss = new WebSocketServer({ noServer: true });
  // Authenticated clients only — pre-auth sockets live in `pending` until
  // they pass the handshake, then graduate into `clients`.
  const clients = new Map<WebSocket, ClientInfo>();
  const pending = new Map<WebSocket, PendingAuth>();

  // Accept the upgrade unconditionally — auth happens after the socket is
  // open via the first-message handshake. The HTTP layer is still
  // responsible for host/origin checks (see http-server.ts).
  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // Handle new connections (unauthenticated at this point)
  wss.on('connection', (ws: WebSocket, _request: IncomingMessage) => {
    log.debug('[WsServer] Connection opened, awaiting auth handshake');

    // Arm the auth timeout. If no message arrives within AUTH_TIMEOUT_MS,
    // close the socket with 4408 and free the slot.
    const timeout = setTimeout(() => {
      log.warn('[WsServer] Auth timeout — closing connection');
      pending.delete(ws);
      try {
        ws.close(WS_CLOSE_AUTH_TIMEOUT, 'auth timeout');
      } catch (error) {
        log.debug('[WsServer] Error closing on auth timeout:', error);
      }
    }, AUTH_TIMEOUT_MS);

    pending.set(ws, { timeout });

    ws.on('message', (data) => {
      // If still pending, treat the message as an auth attempt.
      const pendingState = pending.get(ws);
      if (pendingState) {
        handleAuthMessage(ws, data.toString(), pendingState, pending, clients, pairingManager);
        return;
      }

      // Authenticated path — normal message dispatch.
      const clientInfo = clients.get(ws);
      if (!clientInfo) {
        // Should not happen: socket exists in neither pending nor clients.
        log.warn('[WsServer] Message from unknown socket — closing');
        try {
          ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        } catch {
          // swallow
        }
        return;
      }

      try {
        const message = JSON.parse(data.toString()) as WsMessage;
        // Ignore (but log) any post-auth `auth` frames — clients should not
        // re-authenticate on an already-authenticated socket.
        if (message.type === 'auth') {
          log.warn(`[WsServer] Ignoring duplicate auth frame from ${clientInfo.device.name}`);
          return;
        }
        handleClientMessage(ws, message, clientInfo);
      } catch (error) {
        log.error('[WsServer] Error parsing message:', error);
        sendMessage(ws, {
          type: 'error',
          payload: { message: 'Invalid message format' },
          timestamp: Date.now(),
        });
      }
    });

    // Handle disconnection — clean up either pending or authenticated state.
    ws.on('close', () => {
      const pendingState = pending.get(ws);
      if (pendingState) {
        clearTimeout(pendingState.timeout);
        pending.delete(ws);
        log.debug('[WsServer] Pre-auth connection closed');
        return;
      }
      const info = clients.get(ws);
      if (info) {
        log.info(`[WsServer] Client disconnected: ${info.device.name}`);
        clients.delete(ws);
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      log.error('[WsServer] WebSocket error:', error);
    });
  });

  // Set up PTY data forwarding
  setupPtyForwarding(clients);

  return {
    broadcast(message: WsMessage): void {
      const data = JSON.stringify(message);
      for (const [ws] of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      }
    },

    broadcastToSession(sessionId: string, message: WsMessage): void {
      const data = JSON.stringify(message);
      for (const [ws, info] of clients) {
        if (ws.readyState === WebSocket.OPEN && info.subscribedSessions.has(sessionId)) {
          ws.send(data);
        }
      }
    },

    closeConnectionsForDevice(deviceId: string): void {
      for (const [ws, info] of clients) {
        if (info.device.id !== deviceId) continue;
        try {
          ws.close(WS_CLOSE_UNAUTHORIZED, 'device unpaired');
        } catch (error) {
          log.debug('[WsServer] Error closing connection for unpaired device:', error);
        }
        clients.delete(ws);
      }
    },

    getClientCount(): number {
      return clients.size;
    },

    close(): void {
      // Tear down any in-flight auth attempts first.
      for (const [ws, state] of pending) {
        clearTimeout(state.timeout);
        try {
          ws.close(1001, 'Server shutting down');
        } catch {
          // swallow
        }
      }
      pending.clear();

      for (const [ws] of clients) {
        ws.close(1000, 'Server shutting down');
      }
      wss.close();
    },
  };
}

/**
 * Process a message arriving on a socket that has not yet authenticated.
 *
 * On success: graduates the socket from `pending` into `clients` and sends
 * the `connected` welcome frame.
 * On any failure: closes the socket with 4401.
 */
function handleAuthMessage(
  ws: WebSocket,
  raw: string,
  pendingState: PendingAuth,
  pending: Map<WebSocket, PendingAuth>,
  clients: Map<WebSocket, ClientInfo>,
  pairingManager: PairingManager
): void {
  const rejectUnauthorized = (reason: string): void => {
    log.warn(`[WsServer] Rejecting connection: ${reason}`);
    clearTimeout(pendingState.timeout);
    pending.delete(ws);
    try {
      ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
    } catch (error) {
      log.debug('[WsServer] Error closing on unauthorized:', error);
    }
  };

  let message: WsMessage;
  try {
    message = JSON.parse(raw) as WsMessage;
  } catch {
    rejectUnauthorized('malformed first frame');
    return;
  }

  if (!message || message.type !== 'auth') {
    rejectUnauthorized(`expected auth frame, got type=${message?.type}`);
    return;
  }

  const token = (message as { token?: unknown }).token;
  if (typeof token !== 'string' || token.length === 0) {
    rejectUnauthorized('missing or invalid token field');
    return;
  }

  const device = pairingManager.validateToken(token);
  if (!device) {
    rejectUnauthorized('token failed validation');
    return;
  }

  // Auth success — clear timeout, promote to authenticated client.
  clearTimeout(pendingState.timeout);
  pending.delete(ws);

  clients.set(ws, {
    device,
    subscribedSessions: new Set(),
  });

  log.info(`[WsServer] Client authenticated: ${device.name} (${device.platform})`);

  // Touch lastUsedAt so the device list reflects the connection.
  try {
    pairingManager.updateLastUsed(device.id);
  } catch (error) {
    log.debug('[WsServer] Error updating lastUsedAt:', error);
  }

  sendMessage(ws, {
    type: 'connected',
    payload: {
      deviceId: device.id,
      canControl: device.canControl,
      canModify: device.canModify,
    },
    timestamp: Date.now(),
  });
}

/**
 * Handle messages from clients
 */
function handleClientMessage(ws: WebSocket, message: WsMessage, clientInfo: ClientInfo): void {
  switch (message.type) {
    case 'terminal:subscribe': {
      const sessionId = message.sessionId;
      if (sessionId) {
        clientInfo.subscribedSessions.add(sessionId);
        log.debug(`[WsServer] Client subscribed to session: ${sessionId}`);
        sendMessage(ws, {
          type: 'terminal:subscribed',
          sessionId,
          timestamp: Date.now(),
        });
      }
      break;
    }

    case 'terminal:unsubscribe': {
      const sessionId = message.sessionId;
      if (sessionId) {
        clientInfo.subscribedSessions.delete(sessionId);
        log.debug(`[WsServer] Client unsubscribed from session: ${sessionId}`);
      }
      break;
    }

    case 'terminal:input': {
      if (!clientInfo.device.canControl) {
        sendMessage(ws, {
          type: 'error',
          payload: { message: 'Control permission required' },
          timestamp: Date.now(),
        });
        return;
      }

      const sessionId = message.sessionId;
      const data = (message.payload as { data?: string })?.data;

      if (sessionId && data && ptyManager.getSession(sessionId)) {
        ptyManager.write(sessionId, data);
      }
      break;
    }

    case 'terminal:resize': {
      if (!clientInfo.device.canControl) {
        sendMessage(ws, {
          type: 'error',
          payload: { message: 'Control permission required' },
          timestamp: Date.now(),
        });
        return;
      }

      const sessionId = message.sessionId;
      const { cols, rows } = (message.payload as { cols?: number; rows?: number }) || {};

      if (sessionId && cols && rows && ptyManager.getSession(sessionId)) {
        ptyManager.resize(sessionId, cols, rows);
      }
      break;
    }

    case 'ping': {
      sendMessage(ws, {
        type: 'pong',
        payload: { clientTimestamp: message.timestamp },
        timestamp: Date.now(),
      });
      break;
    }

    default:
      log.warn(`[WsServer] Unknown message type: ${message.type}`);
  }
}

/**
 * Set up forwarding of PTY data to subscribed clients
 */
function setupPtyForwarding(clients: Map<WebSocket, ClientInfo>): void {
  // Listen for PTY data events
  ptyManager.on('data', ({ id, data }: { id: string; data: string }) => {
    const message: WsMessage = {
      type: 'terminal:output',
      sessionId: id,
      payload: { data },
      timestamp: Date.now(),
    };

    const msgStr = JSON.stringify(message);

    for (const [ws, info] of clients) {
      if (ws.readyState === WebSocket.OPEN && info.subscribedSessions.has(id)) {
        ws.send(msgStr);
      }
    }
  });

  // Listen for PTY exit events
  ptyManager.on('exit', ({ id, exitCode }: { id: string; exitCode: number }) => {
    const message: WsMessage = {
      type: 'terminal:exit',
      sessionId: id,
      payload: { exitCode },
      timestamp: Date.now(),
    };

    const msgStr = JSON.stringify(message);

    for (const [ws, info] of clients) {
      if (ws.readyState === WebSocket.OPEN && info.subscribedSessions.has(id)) {
        ws.send(msgStr);
      }
    }
  });
}

/**
 * Send a message to a single client
 */
function sendMessage(ws: WebSocket, message: WsMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
