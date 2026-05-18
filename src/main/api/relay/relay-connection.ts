/**
 * Relay Connection
 *
 * Manages WebSocket connection to the relay server for remote mobile access.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_RELAY_URL = 'wss://cl-relay.sytanek.tech';
const RECONNECT_INTERVAL = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

interface RelayMessage {
  type: string;
  payload?: unknown;
  deviceToken?: string;
  from?: string;
  data?: unknown;
  error?: string;
}

export interface RelayConnectionConfig {
  relayUrl?: string;
  desktopId?: string;
}

export interface RelayConnectionStatus {
  enabled: boolean;
  connected: boolean;
  desktopId: string | null;
  relayUrl: string;
}

export class RelayConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private relayUrl: string;
  private desktopId: string;
  private enabled: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(config: RelayConnectionConfig = {}) {
    super();
    this.relayUrl = config.relayUrl || DEFAULT_RELAY_URL;
    this.desktopId = config.desktopId || this.loadOrCreateDesktopId();
  }

  /**
   * Load desktop ID from file or create new one
   */
  private loadOrCreateDesktopId(): string {
    const configDir = path.join(app.getPath('userData'), 'relay');
    const idFile = path.join(configDir, 'desktop-id.txt');

    try {
      if (fs.existsSync(idFile)) {
        const id = fs.readFileSync(idFile, 'utf-8').trim();
        if (id) {
          log.info(`[RelayConnection] Loaded desktop ID: ${id}`);
          return id;
        }
      }
    } catch (error) {
      log.warn('[RelayConnection] Failed to load desktop ID:', error);
    }

    // Create new ID
    const newId = randomUUID();
    try {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(idFile, newId);
      log.info(`[RelayConnection] Created new desktop ID: ${newId}`);
    } catch (error) {
      log.error('[RelayConnection] Failed to save desktop ID:', error);
    }

    return newId;
  }

  /**
   * Enable remote access and connect to relay
   */
  async enable(): Promise<void> {
    if (this.enabled) {
      return;
    }

    log.info('[RelayConnection] Enabling remote access...');
    this.enabled = true;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /**
   * Disable remote access and disconnect from relay
   */
  disable(): void {
    if (!this.enabled) {
      return;
    }

    log.info('[RelayConnection] Disabling remote access...');
    this.enabled = false;
    this.disconnect();
  }

  /**
   * Connect to relay server
   */
  private async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      log.debug('[RelayConnection] Already connected');
      return;
    }

    try {
      log.info(`[RelayConnection] Connecting to ${this.relayUrl}...`);

      this.ws = new WebSocket(this.relayUrl);

      this.ws.on('open', () => {
        log.info('[RelayConnection] Connected to relay');
        this.reconnectAttempts = 0;

        // Register as desktop
        this.send({
          type: 'desktop:connect',
          desktopId: this.desktopId,
        });

        // Start ping interval
        this.startPing();

        this.emit('connected');
      });

      this.ws.on('message', (data) => {
        try {
          const message: RelayMessage = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          log.error('[RelayConnection] Failed to parse message:', error);
        }
      });

      this.ws.on('close', (code, reason) => {
        log.info(`[RelayConnection] Disconnected: ${code} ${reason.toString()}`);
        this.stopPing();
        this.emit('disconnected');

        if (this.enabled) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        // BDHLNDR-41: connection-level failures (e.g. getaddrinfo ENOTFOUND
        // when offline / DNS down) arrive here. `emit('error', …)` on an
        // EventEmitter with no registered 'error' listener re-throws as an
        // uncaught exception, so guard it. Reconnect is handled by the 'close'
        // handler that follows a failed ws connection — treat this as
        // transient, not fatal.
        log.warn(
          '[RelayConnection] WebSocket error (will retry):',
          error instanceof Error ? error.message : error
        );
        if (this.listenerCount('error') > 0) {
          this.emit('error', error);
        }
      });
    } catch (error) {
      log.error('[RelayConnection] Failed to connect:', error);
      if (this.enabled) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Disconnect from relay server
   */
  private disconnect(): void {
    this.stopPing();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'User disabled remote access');
      this.ws = null;
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log.error('[RelayConnection] Max reconnect attempts reached, giving up');
      this.emit('reconnect_failed');
      return;
    }

    this.reconnectAttempts++;
    const delay = RECONNECT_INTERVAL * Math.min(this.reconnectAttempts, 5);
    log.info(`[RelayConnection] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Start ping interval for keepalive
   */
  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 30000);
  }

  /**
   * Stop ping interval
   */
  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Handle incoming message from relay
   */
  private handleMessage(message: RelayMessage): void {
    switch (message.type) {
      case 'mobile:connected':
        log.info(`[RelayConnection] Mobile connected: ${message.deviceToken}`);
        this.emit('mobile_connected', message.deviceToken);
        break;

      case 'mobile:disconnected':
        log.info(`[RelayConnection] Mobile disconnected: ${message.deviceToken}`);
        this.emit('mobile_disconnected', message.deviceToken);
        break;

      case 'relay':
        // Forward to handler
        this.emit('message', message.payload);
        break;

      case 'pong':
        // Keepalive response, ignore
        break;

      case 'error':
        log.error('[RelayConnection] Relay error:', message.error);
        this.emit('relay_error', message.error);
        break;

      default:
        log.debug(`[RelayConnection] Unknown message type: ${message.type}`);
    }
  }

  /**
   * Send message to relay
   */
  send(message: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log.error('[RelayConnection] Failed to send message:', error);
      return false;
    }
  }

  /**
   * Send response to mobile client via relay
   */
  sendToMobile(payload: unknown): boolean {
    return this.send({
      type: 'relay',
      payload,
    });
  }

  /**
   * Get connection status
   */
  getStatus(): RelayConnectionStatus {
    return {
      enabled: this.enabled,
      connected: this.ws?.readyState === WebSocket.OPEN,
      desktopId: this.desktopId,
      relayUrl: this.relayUrl,
    };
  }

  /**
   * Get desktop ID for pairing
   */
  getDesktopId(): string {
    return this.desktopId;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
let relayConnection: RelayConnection | null = null;

export function getRelayConnection(): RelayConnection {
  if (!relayConnection) {
    relayConnection = new RelayConnection();
  }
  return relayConnection;
}
