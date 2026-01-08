/**
 * mDNS/Bonjour Service Advertiser
 *
 * Advertises the ClaudeLander API server on the local network
 * so mobile companion apps can discover it automatically.
 */

import Bonjour, { Service } from 'bonjour-service';
import { hostname } from 'os';
import { app } from 'electron';
import log from 'electron-log';

const SERVICE_TYPE = 'claudelander';
const SERVICE_PROTOCOL = 'tcp';

export class MdnsAdvertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;

  /**
   * Start advertising the service on the local network
   */
  async advertise(port: number): Promise<void> {
    try {
      this.bonjour = new Bonjour();

      const name = `ClaudeLander on ${hostname()}`;

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
        log.error('[MdnsAdvertiser] Service error:', error);
      });

      log.info(`[MdnsAdvertiser] Advertising as "${name}" (_${SERVICE_TYPE}._${SERVICE_PROTOCOL})`);
    } catch (error) {
      log.error('[MdnsAdvertiser] Failed to start:', error);
      throw error;
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
 * Discover ClaudeLander instances on the local network
 * (Useful for mobile app, but can also be used for testing)
 */
export class MdnsDiscovery {
  private bonjour: Bonjour | null = null;
  private browser: ReturnType<Bonjour['find']> | null = null;
  private discovered = new Map<string, DiscoveredService>();
  private listeners = new Set<(services: DiscoveredService[]) => void>();

  start(): void {
    this.bonjour = new Bonjour();

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

    log.info('[MdnsDiscovery] Started scanning for ClaudeLander instances');
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
