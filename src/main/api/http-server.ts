/**
 * HTTP Server Setup
 *
 * Creates an Express server with security middleware and API routes.
 */

import { createServer, Server } from 'http';
import * as path from 'path';
import * as fs from 'fs';
import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import log from 'electron-log';
import { PairingManager } from './pairing/pairing-manager';
import { authenticateDevice } from './middleware/auth';
import { createSessionsRouter } from './routes/sessions';
import { createGroupsRouter } from './routes/groups';
import { createSystemRouter } from './routes/system';
import { createPairingRouter } from './routes/pairing';
import { createTerminalRouter } from './routes/terminal';
import { createHooksRouter } from './routes/hooks';
import { createWebPushRouter } from './routes/web-push';

export interface HttpServerConfig {
  port: number;
  bindAddress: string;
  pairingManager: PairingManager;
  /**
   * Called after a successful unpair (BDHLNDR-67) so the WS server can close
   * any open connections owned by the deleted device. Wired after wsServer
   * exists; safe to omit during early bootstrap.
   */
  onDeviceUnpaired?: (deviceId: string) => void;
}

export interface HttpServerResult {
  app: Express;
  server: Server;
  port: number;
}

/**
 * Check if an IP address is on the local network
 */
function isLocalNetworkIp(ip: string): boolean {
  // Allow loopback
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
    return true;
  }

  // Allow private IP ranges
  const privateRanges = [
    /^10\./,                                       // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,              // 172.16.0.0/12
    /^192\.168\./,                                 // 192.168.0.0/16
    /^169\.254\./,                                 // Link-local
    // Tailscale CGNAT (100.64.0.0/10) — admit mobile peers reaching the
    // desktop directly over the tailnet. Funnel-routed traffic enters via
    // 127.0.0.1 and is already covered by the loopback branch above.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
    /^fc00:/,                                      // IPv6 unique local
    /^fe80:/,                                      // IPv6 link-local
  ];

  return privateRanges.some(range => range.test(ip));
}

/**
 * Extract client IP from request
 */
function getClientIp(req: Request): string {
  // Don't trust X-Forwarded-For - we're not behind a proxy
  const ip = req.socket.remoteAddress || '';
  // Handle IPv4-mapped IPv6 addresses
  return ip.replace(/^::ffff:/, '');
}

/**
 * Middleware to restrict access to local network only
 */
function localNetworkOnly(req: Request, res: Response, next: NextFunction): void {
  const clientIp = getClientIp(req);

  if (!isLocalNetworkIp(clientIp)) {
    log.warn(`[HttpServer] Rejected connection from non-local IP: ${clientIp}`);
    res.status(403).json({ error: 'Access denied: local network only' });
    return;
  }

  next();
}

/**
 * Create and configure the Express HTTP server
 */
export async function createHttpServer(config: HttpServerConfig): Promise<HttpServerResult> {
  const app = express();

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: false, // API only, no HTML
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow cross-origin for mobile app
  }));

  // CORS — accept any origin. The previous "reject anything with an Origin
  // header" logic was based on a wrong assumption: browsers DO send Origin
  // for same-origin requests when the resource is loaded with `crossorigin`
  // (which vite emits on every <script type="module"> and the matching
  // <link rel="stylesheet">). The PWA's own asset requests were getting
  // 500 + application/json bodies from this middleware, which the browser
  // refused to apply (MIME mismatch on CSS, broken JS) — hence white screen
  // on every mobile load of /m/ (BDHLNDR-69 again, real fix).
  //
  // Threat model: the localNetworkOnly middleware above is the real access
  // gate. CORS is a browser-enforced same-origin policy meant for public
  // services; for a LAN-only API there's no cross-origin attacker scenario
  // it can prevent that localNetworkOnly doesn't already block at the
  // network layer. Reflect the requesting origin so credentials-bearing
  // requests work (CORS spec disallows `*` with credentials).
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      callback(null, origin);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  }));

  // Restrict to local network
  app.use(localNetworkOnly);

  // BDHLNDR-52: Serve the mobile-companion PWA bundle from /m/*.
  // The PWA is built into dist/pwa/ by the `build:pwa` script. This file
  // compiles to dist/main/api/http-server.js, so the bundle lives two
  // directories up at ../../pwa. The static handler covers concrete assets
  // (/m/assets/*, /m/sw.js, /m/manifest.webmanifest, /m/index.html, etc.);
  // the SPA fallback below serves dist/pwa/index.html for any unmatched
  // /m/* path so client-side routing works on hard refresh. No auth is
  // required here — auth happens inside the PWA after pairing, exactly
  // like the /api/v1/pairing initiation endpoints.
  //
  // BDHLNDR-69 follow-up: in packaged builds dist/pwa is asarUnpacked (see
  // electron-builder.yml), so the real files live under app.asar.unpacked/.
  // Electron's fs wrapper auto-redirects asar paths for most calls, but the
  // `send` package that express.static uses internally resolves paths in
  // ways that don't always trigger the redirect — the result was 500s on
  // asset requests that fell through to the SPA fallback. Substituting the
  // unpacked path here means express.static gets a real on-disk path. In
  // dev mode the substitution is a no-op (the path doesn't contain
  // `app.asar`), so the same code works in both modes.
  const pwaDistDir = path
    .join(__dirname, '..', '..', 'pwa')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const pwaIndexHtml = path.join(pwaDistDir, 'index.html');
  app.use(
    '/m',
    express.static(pwaDistDir, {
      // Let the SPA fallback handle the index so we don't double-serve and
      // so unknown extensions cleanly fall through to the catch-all below.
      index: false,
      fallthrough: true,
      // Aggressive caching for hashed assets; the index is served by the
      // fallback handler with no-cache headers (see below).
      maxAge: '1h',
    }),
  );
  app.get(/^\/m(?:\/.*)?$/, (_req, res, next) => {
    if (!fs.existsSync(pwaIndexHtml)) {
      // Bundle missing in this build — surface a clear error rather than a
      // generic 404 from the catch-all handler below.
      log.warn(`[HttpServer] PWA index missing at ${pwaIndexHtml}`);
      res.status(404).json({ error: 'PWA bundle not built' });
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(pwaIndexHtml, (err) => {
      if (err) next(err);
    });
  });

  // Parse JSON bodies
  app.use(express.json({ limit: '1mb' }));

  // Rate limiting
  const generalLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const pairingLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 pairing attempts per minute
    message: { error: 'Too many pairing attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Health check endpoint (no auth required)
  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Pairing routes (rate limited, no auth required for initiation)
  app.use('/api/v1/pairing', pairingLimiter, createPairingRouter(config.pairingManager, config.onDeviceUnpaired));

  // Hook routes for Claude Code hooks (localhost-only, no device auth needed)
  app.use('/api/v1/hooks', generalLimiter, createHooksRouter());

  // Web Push routes (BDHLNDR-49). Mounts BOTH the unauthenticated
  // /public-key endpoint and the auth-required /subscribe endpoints. The
  // router applies authenticateDevice per-route so we can't accidentally
  // shield the public key behind a token the PWA doesn't have yet.
  app.use('/api/v1/web-push', generalLimiter, createWebPushRouter(config.pairingManager));

  // Protected routes (require device authentication)
  const authMiddleware = authenticateDevice(config.pairingManager);
  app.use('/api/v1/sessions', generalLimiter, authMiddleware, createSessionsRouter());
  app.use('/api/v1/groups', generalLimiter, authMiddleware, createGroupsRouter());
  app.use('/api/v1/system', generalLimiter, authMiddleware, createSystemRouter());
  app.use('/api/v1/terminal', generalLimiter, authMiddleware, createTerminalRouter());

  // Error handling middleware
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('[HttpServer] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Create HTTP server
  const server = createServer(app);

  // Find available port
  const port = await findAvailablePort(config.port, config.bindAddress, server);

  return { app, server, port };
}

/**
 * Find an available port, trying the preferred port first
 */
async function findAvailablePort(
  preferredPort: number,
  bindAddress: string,
  server: Server
): Promise<number> {
  const maxAttempts = 100;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = preferredPort + attempt;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            log.debug(`[HttpServer] Port ${port} is in use, trying next...`);
            resolve(); // Try next port
          } else {
            reject(err);
          }
        });

        server.listen(port, bindAddress, () => {
          log.info(`[HttpServer] Listening on ${bindAddress}:${port}`);
          resolve();
        });
      });

      // Check if server is actually listening
      const address = server.address();
      if (address && typeof address === 'object') {
        return address.port;
      }
    } catch (error) {
      log.error(`[HttpServer] Error binding to port ${port}:`, error);
      throw error;
    }
  }

  throw new Error(`Could not find available port after ${maxAttempts} attempts`);
}
