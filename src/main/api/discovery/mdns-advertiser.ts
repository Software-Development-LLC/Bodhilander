/**
 * mDNS/Bonjour Service Advertiser
 *
 * Advertises the Bodhilander API server on the local network
 * so mobile companion apps can discover it automatically.
 */

import Bonjour, { Service } from 'bonjour-service';
import { hostname } from 'os';
import { app } from 'electron';
import log from 'electron-log';

const SERVICE_TYPE = 'bodhilander';
const SERVICE_PROTOCOL = 'tcp';

// BDHLNDR-41: bonjour-service wraps a multicast-dns dgram socket. Transient
// network failures (sleep/wake, Wi-Fi switch, VPN, no route to the mDNS
// multicast group) surface as `send ENETUNREACH 224.0.0.251:5353` emitted on
// the underlying mdns instance/socket — which bonjour-service leaves without
// an 'error' listener, so it escapes to process 'uncaughtException'. mDNS is
// best-effort; bonjour re-announces periodically and self-heals when the
// network returns, so these are non-fatal: log and swallow.
const TRANSIENT_NET_CODES = new Set([
  'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN',
  'ENODEV', 'EADDRNOTAVAIL', 'EPERM',
]);

/**
 * Attach an 'error' handler to the multicast-dns instance/socket inside a
 * bonjour-service instance so transient socket send failures don't crash the
 * main process. `_server.mdns` is internal to bonjour-service but stable
 * across its 1.x; optional-chained so a library shape change degrades to the
 * prior behavior (no regression) rather than throwing here.
 */
function attachMdnsErrorHandler(bonjour: Bonjour, context: string): void {
  const mdns: any = (bonjour as any)?._server?.mdns;
  if (!mdns || typeof mdns.on !== 'function') return;

  const onError = (err: NodeJS.ErrnoException) => {
    const code = err?.code ?? '';
    if (TRANSIENT_NET_CODES.has(code)) {
      log.warn(
        `[${context}] Transient network error (${code}) — mDNS paused, ` +
          `will recover when the network returns`
      );
    } else {
      log.warn(`[${context}] mDNS socket error (discovery degraded):`, err?.message || err);
    }
  };

  mdns.on('error', onError);
  // Some multicast-dns versions surface socket send errors on the dgram
  // socket directly rather than on the mdns instance.
  if (mdns.socket && typeof mdns.socket.on === 'function') {
    mdns.socket.on('error', onError);
  }
}

export class MdnsAdvertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  /**
   * Start advertising the service on the local network
   */
  async advertise(port: number): Promise<void> {
    try {
      this.bonjour = new Bonjour();
      attachMdnsErrorHandler(this.bonjour, 'MdnsAdvertiser');

      // Use a unique name with random suffix to avoid conflicts
      const uniqueId = Math.random().toString(36).substring(2, 8);
      const name = `Bodhilander-${hostname()}-${uniqueId}`;

      this.service = this.bonjour.publish({
        name,
        type: SERVICE_TYPE,
        protocol: SERVICE_PROTOCOL,
        port,
        txt: {
          version: app.getVersion(),
          platform: process.platform,
          hostname: hostname(),
        },
      });

      this.service.on('up', () => {
        log.info(`[MdnsAdvertiser] Service published: ${name} on port ${port}`);
      });

      this.service.on('error', (error) => {
        // Handle "already in use" errors gracefully - mDNS is optional for pairing
        log.warn('[MdnsAdvertiser] Service error (mDNS discovery disabled):', error.message || error);
      });

      log.info(`[MdnsAdvertiser] Advertising as "${name}" (_${SERVICE_TYPE}._${SERVICE_PROTOCOL})`);
    } catch (error) {
      // mDNS is optional - log warning but don't throw
      log.warn('[MdnsAdvertiser] Failed to start mDNS (discovery disabled):', error);
    }
  }

  /**
   * Stop advertising the service
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.service) {
        const service = this.service;
        // Some versions of bonjour-service have stop as optional
        if (typeof service.stop === 'function') {
          service.stop(() => {
            log.info('[MdnsAdvertiser] Service unpublished');
            this.service = null;
            this.cleanup();
            resolve();
          });
        } else {
          this.service = null;
          this.cleanup();
          resolve();
        }
      } else {
        this.cleanup();
        resolve();
      }
    });
  }

  private cleanup(): void {
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
  }
}

/**
 * Discover Bodhilander instances on the local network
 * (Useful for mobile app, but can also be used for testing)
 */
export class MdnsDiscovery {
  private bonjour: Bonjour | null = null;
  private browser: ReturnType<Bonjour['find']> | null = null;
  private discovered = new Map<string, DiscoveredService>();
  private listeners = new Set<(services: DiscoveredService[]) => void>();

  start(): void {
    this.bonjour = new Bonjour();
    attachMdnsErrorHandler(this.bonjour, 'MdnsDiscovery');

    this.browser = this.bonjour.find({
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL,
    });

    this.browser.on('up', (service) => {
      const discovered: DiscoveredService = {
        name: service.name,
        host: service.host,
        port: service.port,
        addresses: service.addresses || [],
        txt: service.txt as Record<string, string>,
      };

      this.discovered.set(service.name, discovered);
      this.notifyListeners();

      log.info(`[MdnsDiscovery] Found: ${service.name} at ${service.host}:${service.port}`);
    });

    this.browser.on('down', (service) => {
      this.discovered.delete(service.name);
      this.notifyListeners();

      log.info(`[MdnsDiscovery] Lost: ${service.name}`);
    });

    log.info('[MdnsDiscovery] Started scanning for Bodhilander instances');
  }

  stop(): void {
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }

    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }

    this.discovered.clear();
    log.info('[MdnsDiscovery] Stopped');
  }

  getDiscovered(): DiscoveredService[] {
    return Array.from(this.discovered.values());
  }

  subscribe(listener: (services: DiscoveredService[]) => void): () => void {
    this.listeners.add(listener);
    // Immediately notify with current state
    listener(this.getDiscovered());
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const services = this.getDiscovered();
    for (const listener of this.listeners) {
      listener(services);
    }
  }
}

export interface DiscoveredService {
  name: string;
  host: string;
  port: number;
  addresses: string[];
  txt: Record<string, string>;
}
