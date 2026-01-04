import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import { RELAY_URL } from '../../shared/constants';
import { authService } from './auth';
import * as crypto from './crypto';
import log from 'electron-log';

interface RelayEvents {
  connected: () => void;
  disconnected: () => void;
  guestJoined: (info: { userId: string; guestPublicKey: string; permission: string }) => void;
  guestLeft: (info: { userId: string }) => void;
  data: (data: Buffer) => void;
  error: (error: Error) => void;
}

export class RelayClient extends EventEmitter {
  private socket: Socket | null = null;
  private keyPair: crypto.KeyPair | null = null;
  private sharedSecrets: Map<string, Buffer> = new Map();
  private sessionId: string | null = null;
  private isHost = false;
  private permission: 'read' | 'control' = 'read';

  constructor() {
    super();
  }

  /**
   * Connect to relay as host (sharing a session)
   */
  async connectAsHost(localSessionId: string): Promise<{ sessionId: string; publicKey: string }> {
    this.keyPair = crypto.generateKeyPair();
    this.isHost = true;

    // Register session with relay server
    log.info('Creating share session at:', `${RELAY_URL}/sessions`);
    const response = await fetch(`${RELAY_URL}/sessions`, {
      method: 'POST',
      headers: authService.getHeaders(),
      body: JSON.stringify({
        hostPublicKey: crypto.toBase64(this.keyPair.publicKey),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('Failed to create share session:', response.status, errorText);
      throw new Error(`Failed to create share session: ${response.status} ${errorText}`);
    }

    const session = await response.json();
    this.sessionId = session.id;

    // Connect WebSocket
    await this.connectSocket();

    // Join as host
    this.socket!.emit('joinAsHost', {
      token: authService.token,
      sessionId: session.id,
    });

    return {
      sessionId: session.id,
      publicKey: crypto.toBase64(this.keyPair.publicKey),
    };
  }

  /**
   * Connect to relay as guest (joining a shared session)
   */
  async connectAsGuest(code: string): Promise<{
    hostPublicKey: string;
    permission: 'read' | 'control';
  }> {
    this.keyPair = crypto.generateKeyPair();
    this.isHost = false;

    await this.connectSocket();

    return new Promise((resolve, reject) => {
      this.socket!.emit(
        'joinAsGuest',
        {
          token: authService.token,
          code,
          guestPublicKey: crypto.toBase64(this.keyPair!.publicKey),
        },
        (response: any) => {
          if (response.error) {
            reject(new Error(response.error));
            return;
          }

          this.permission = response.permission;
          const hostPublicKey = crypto.fromBase64(response.hostPublicKey);
          const sharedSecret = crypto.deriveSharedSecret(
            this.keyPair!.secretKey,
            hostPublicKey,
          );
          this.sharedSecrets.set('host', sharedSecret);

          resolve({
            hostPublicKey: response.hostPublicKey,
            permission: response.permission,
          });
        },
      );
    });
  }

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(`${RELAY_URL}/relay`, {
        transports: ['websocket'],
      });

      this.socket.on('connect', () => {
        log.info('Connected to relay');
        this.emit('connected');
        resolve();
      });

      this.socket.on('disconnect', () => {
        log.info('Disconnected from relay');
        this.emit('disconnected');
      });

      this.socket.on('connect_error', (error) => {
        log.error('Relay connection error:', error);
        reject(error);
      });

      this.socket.on('guestJoined', (info) => {
        log.info('Guest joined:', info.userId);
        // Derive shared secret for this guest
        const guestPublicKey = crypto.fromBase64(info.guestPublicKey);
        const sharedSecret = crypto.deriveSharedSecret(
          this.keyPair!.secretKey,
          guestPublicKey,
        );
        this.sharedSecrets.set(info.userId, sharedSecret);
        this.emit('guestJoined', info);
      });

      this.socket.on('peerDisconnected', (info) => {
        log.info('Peer disconnected:', info.userId);
        this.sharedSecrets.delete(info.userId);
        this.emit('guestLeft', info);
      });

      this.socket.on('relayData', (data) => {
        try {
          const ciphertext = crypto.fromBase64(data.encryptedData);
          const nonce = crypto.fromBase64(data.nonce);

          // Determine which shared secret to use
          const secretKey = data.from === 'host' ? 'host' : data.fromUserId;
          const sharedSecret = this.sharedSecrets.get(secretKey);

          if (!sharedSecret) {
            log.warn('No shared secret for:', secretKey);
            return;
          }

          const decrypted = crypto.decrypt(ciphertext, nonce, sharedSecret);
          this.emit('data', decrypted);
        } catch (e) {
          log.error('Failed to decrypt relay data:', e);
        }
      });
    });
  }

  /**
   * Send data to all connected peers (encrypted)
   */
  send(data: Buffer | string): void {
    if (!this.socket || !this.keyPair) {
      throw new Error('Not connected');
    }

    // For host: encrypt with each guest's shared secret
    // For guest: encrypt with host's shared secret
    if (this.isHost) {
      for (const [userId, sharedSecret] of this.sharedSecrets) {
        const { ciphertext, nonce } = crypto.encrypt(data, sharedSecret);
        this.socket.emit('relay', {
          encryptedData: crypto.toBase64(ciphertext),
          nonce: crypto.toBase64(nonce),
          targetUserId: userId,
        });
      }
    } else {
      const sharedSecret = this.sharedSecrets.get('host');
      if (sharedSecret) {
        const { ciphertext, nonce } = crypto.encrypt(data, sharedSecret);
        this.socket.emit('relay', {
          encryptedData: crypto.toBase64(ciphertext),
          nonce: crypto.toBase64(nonce),
        });
      }
    }
  }

  /**
   * Check if guest can send input
   */
  canSendInput(): boolean {
    return this.isHost || this.permission === 'control';
  }

  /**
   * Disconnect from relay
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.keyPair = null;
    this.sharedSecrets.clear();
    this.sessionId = null;
  }
}

export const relayClient = new RelayClient();
