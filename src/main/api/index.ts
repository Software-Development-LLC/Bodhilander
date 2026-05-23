/**
 * API Server Module
 *
 * Exposes Bodhilander functionality over HTTP/WebSocket for mobile companion app access.
 * LAN-direct only — mobile devices reach the desktop on the same network or via a
 * user-managed tunnel (Tailscale Funnel recommended).
 */

import { EventEmitter } from 'events';
import { Server as HttpServer } from 'http';
import { networkInterfaces } from 'os';
import log from 'electron-log';
import { createHttpServer } from './http-server';
import { createWsServer, WsServer } from './ws-server';
import { MdnsAdvertiser } from './discovery/mdns-advertiser';
import { PairingManager } from './pairing/pairing-manager';
import type { ChatEvent } from './chat-parser';

export interface ApiServerConfig {
  port: number;
  bindAddress: string;
  enableMdns: boolean;
}

export interface ApiServerStatus {
  running: boolean;
  port: number | null;
  addresses: string[];
  connectedClients: number;
  pairedDevices: number;
}

// Bind to all interfaces so mobile devices on the LAN can reach the server
// (loopback-only would only serve the desktop itself — useless for pairing).
// Access is still gated by the localNetworkOnly middleware in http-server.ts.
const DEFAULT_CONFIG: ApiServerConfig = {
  port: 8443,
  bindAddress: '0.0.0.0',
  enableMdns: true,
};

class ApiServer extends EventEmitter {
  private httpServer: HttpServer | null = null;
  private wsServer: WsServer | null = null;
  private mdnsAdvertiser: MdnsAdvertiser | null = null;
  private config: ApiServerConfig;
  private _isRunning = false;
  private _port: number | null = null;

  public readonly pairingManager: PairingManager;

  constructor(config: Partial<ApiServerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pairingManager = new PairingManager();
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get port(): number | null {
    return this._port;
  }

  get addresses(): string[] {
    return this.getLocalAddresses();
  }

  get connectedClientCount(): number {
    return this.wsServer?.getClientCount() ?? 0;
  }

  async start(): Promise<{ port: number; addresses: string[] }> {
    if (this._isRunning) {
      throw new Error('API server is already running');
    }

    log.info('[ApiServer] Starting API server...');

    try {
      // Create HTTP server with Express
      const { server, port } = await createHttpServer({
        port: this.config.port,
        bindAddress: this.config.bindAddress,
        pairingManager: this.pairingManager,
      });

      this.httpServer = server;
      this._port = port;

      // Create WebSocket server attached to HTTP server
      this.wsServer = createWsServer(this.httpServer, this.pairingManager);

      // Start mDNS advertisement
      if (this.config.enableMdns) {
        this.mdnsAdvertiser = new MdnsAdvertiser();
        await this.mdnsAdvertiser.advertise(port);
      }

      this._isRunning = true;
      const addresses = this.getLocalAddresses();

      log.info(`[ApiServer] Started on port ${port}`);
      log.info(`[ApiServer] Available at: ${addresses.map(a => `http://${a}:${port}`).join(', ')}`);

      this.emit('started', { port, addresses });

      return { port, addresses };
    } catch (error) {
      log.error('[ApiServer] Failed to start:', error);
      await this.cleanup();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this._isRunning) {
      return;
    }

    log.info('[ApiServer] Stopping API server...');
    await this.cleanup();
    this._isRunning = false;
    this._port = null;
    this.emit('stopped');
    log.info('[ApiServer] Stopped');
  }

  private async cleanup(): Promise<void> {
    // Stop mDNS advertisement
    if (this.mdnsAdvertiser) {
      await this.mdnsAdvertiser.stop();
      this.mdnsAdvertiser = null;
    }

    // Close WebSocket server
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  getStatus(): ApiServerStatus {
    return {
      running: this._isRunning,
      port: this._port,
      addresses: this._isRunning ? this.getLocalAddresses() : [],
      connectedClients: this.connectedClientCount,
      pairedDevices: this.pairingManager.getDeviceCount(),
    };
  }

  private getLocalAddresses(): string[] {
    const addresses: string[] = [];
    const interfaces = networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      const nets = interfaces[name];
      if (!nets) continue;

      for (const net of nets) {
        // Skip internal (loopback) addresses
        if (net.internal) continue;

        // Only include IPv4 addresses for simplicity
        if (net.family === 'IPv4') {
          addresses.push(net.address);
        }
      }
    }

    // Prioritize 192.168.x.x (typical LAN) over 172.x.x (often Docker/WSL/Hyper-V) and 10.x.x
    return addresses.sort((a, b) => {
      const score = (ip: string) => {
        if (ip.startsWith('192.168.')) return 0;
        if (ip.startsWith('10.')) return 1;
        if (ip.startsWith('172.')) return 2;
        return 3;
      };
      return score(a) - score(b);
    });
  }

  broadcastTerminalData(sessionId: string, data: string): void {
    if (this.wsServer) {
      this.wsServer.broadcastToSession(sessionId, {
        type: 'terminal:output',
        sessionId,
        payload: { data },
        timestamp: Date.now(),
      });
    }
  }

  broadcastSessionState(sessionId: string, state: string, event?: string): void {
    if (this.wsServer) {
      this.wsServer.broadcast({
        type: 'session:state',
        sessionId,
        payload: { state, event },
        timestamp: Date.now(),
      });
    }
  }

  broadcastSessionsUpdated(): void {
    if (this.wsServer) {
      this.wsServer.broadcast({
        type: 'sessions:updated',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Broadcast a parsed chat event to all clients subscribed to the session
   * (BDHLNDR-51). Companion channel to broadcastTerminalData — both fire on
   * every PTY chunk: terminal:output carries the raw bytes for the xterm
   * view, chat:event carries the structured classification for the PWA chat
   * view (BDHLNDR-56) and snapshot REST endpoint (BDHLNDR-58).
   *
   * Wire shape (downstream contract — do not break without coordinating):
   *   { type: 'chat:event', sessionId, payload: ChatEvent, timestamp }
   */
  broadcastChatEvent(sessionId: string, event: ChatEvent): void {
    if (this.wsServer) {
      this.wsServer.broadcastToSession(sessionId, {
        type: 'chat:event',
        sessionId,
        payload: event,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Broadcast groups list update to all connected clients
   */
  broadcastGroupsUpdated(): void {
    if (this.wsServer) {
      this.wsServer.broadcast({
        type: 'groups:updated',
        timestamp: Date.now(),
      });
    }
  }
}

// Singleton instance
let apiServerInstance: ApiServer | null = null;

export function getApiServer(): ApiServer {
  if (!apiServerInstance) {
    apiServerInstance = new ApiServer();
  }
  return apiServerInstance;
}

export function createApiServer(config?: Partial<ApiServerConfig>): ApiServer {
  if (apiServerInstance) {
    throw new Error('API server already exists. Use getApiServer() instead.');
  }
  apiServerInstance = new ApiServer(config);
  return apiServerInstance;
}
