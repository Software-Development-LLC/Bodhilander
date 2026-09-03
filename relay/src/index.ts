import { loadConfig } from './config';
import { openDb } from './db';
import { createRouter } from './http';
import { createLogger } from './logger';
import { createRepositories } from './repositories';
import { createGateway, newAgentSocketData, newClientSocketData } from './ws';
import { parseCookies, SESSION_COOKIE } from './auth/cookies';
import { createRateLimiter } from './rate-limit';
import { createVapid } from './push/vapid';
import { createPushDispatcher } from './push/send';
import { serveOptions } from './server';
import { ORPHAN_GRACE_MS, purgeExpiredHandoffs, sweepOrphans } from './handoff-store';

/** How often expired sessions / link codes / rate-limit windows are swept. */
const REAP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Largest frame the relay will forward. Deliberately generous: desktop agents
 * update on their own schedule, and builds before scrollback chunking landed
 * seal an entire serialized buffer into ONE frame (megabytes on a busy
 * session). Lowering this would silently break history replay for clients no
 * relay-side change can fix — revisit once those builds have aged out.
 */
const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** The running server plus the handle a test needs to shut it down again. */
export function main() {
  const { config, warnings } = loadConfig();
  const logger = createLogger(config.logLevel);
  for (const warning of warnings) {
    logger.warn(warning);
  }

  const db = openDb(config.dbPath);
  logger.info('database ready', { path: config.dbPath });

  const repos = createRepositories(db);
  const rateLimiter = createRateLimiter();
  // Web push identity. The keypair is resolved lazily, on the first request
  // that needs it, so a start-up with no push traffic touches no crypto.
  const vapid = createVapid({ config, repos, logger });

  /** Files a crash stranded between writing one and recording it. */
  const sweepHandoffOrphans = async (): Promise<void> => {
    try {
      const swept = await sweepOrphans(config.handoffDir, new Set(repos.listHandoffIds()), ORPHAN_GRACE_MS);
      if (swept > 0) logger.warn('swept orphaned handoff files', { count: swept });
    } catch (err) {
      logger.error('handoff sweep failed', { err: err instanceof Error ? err.message : String(err) });
    }
  };
  void sweepHandoffOrphans();
  // The gateway is built first so the router can call into it. HTTP and
  // WebSocket are separate surfaces; these callbacks are the only seam
  // between them, rather than a shared mutable table either side can corrupt.
  const gateway = createGateway({
    repos,
    logger,
    rateLimiter,
    push: createPushDispatcher({ vapid }),
  });
  const route = createRouter({
    config,
    logger,
    repos,
    rateLimiter,
    vapid,
    onGrantRedeemed: (grant) => gateway.notifyGrantRedeemed(grant),
    onGrantRevoked: (grant) => gateway.notifyGrantRevoked(grant),
    onPushSubscriptionsChanged: (userId) => gateway.notifyPushSubscriptions(userId),
    isPushCapable: (machineId) => gateway.isPushCapable(machineId),
  });

  const server = Bun.serve(serveOptions({
    config,
    fetch(req, srv) {
      const url = new URL(req.url);
      // Agents connect at /ws and authenticate with an Ed25519-signed nonce.
      if (url.pathname === '/ws') {
        if (srv.upgrade(req, { data: newAgentSocketData() })) return undefined;
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      // Web clients connect at /ws/client and are authenticated by session
      // cookie at upgrade time — no cookie, no socket.
      if (url.pathname === '/ws/client') {
        const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
        const user = token ? repos.getUserBySessionToken(token) : null;
        if (!user) return new Response('unauthorized', { status: 401 });
        if (srv.upgrade(req, { data: newClientSocketData(user.id) })) return undefined;
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      return route(req, srv.requestIP(req)?.address ?? null);
    },
    websocket: { ...gateway, maxPayloadLength: MAX_WS_PAYLOAD_BYTES },
  }));

  // Nothing purged expired sessions or link codes before — `purgeExpiredSessions`
  // was on the repository interface but had no caller, so both tables grew
  // without bound. `unref` so a pending tick can't hold shutdown open.
  const reaper = setInterval(() => {
    try {
      repos.purgeExpiredSessions();
      const codes = repos.purgeExpiredLinkCodes();
      // Cut any live socket BEFORE dropping its row. The explicit-revoke path
      // does this via onGrantRevoked; a grant that merely reached its TTL
      // deserves the same treatment, or the guest keeps a channel open to a
      // grant that no longer exists.
      for (const dead of repos.listDeadShareGrants()) gateway.notifyGrantRevoked(dead);
      // Revoked/expired grants and stale unredeemed invites. The desktop keeps
      // its own record, so nothing dropped here is the audit trail.
      const shares = repos.purgeDeadShares();
      if (shares > 0) logger.debug('reaped dead shares', { count: shares });
      void purgeExpiredHandoffs(repos, config.handoffDir)
        .then((count) => {
          if (count > 0) logger.debug('reaped expired handoffs', { count });
        })
        .catch((err) => logger.error('handoff purge failed', { err: String(err) }));
      void sweepHandoffOrphans();
      rateLimiter.sweep();
      if (codes > 0) logger.debug('reaped expired link codes', { count: codes });
      // Only non-zero when someone is holding MAX_WINDOWS buckets at their
      // limit, so this is a deliberate-abuse signal rather than routine noise.
      const refused = rateLimiter.drainSaturationRefusals();
      if (refused > 0) logger.warn('rate limiter saturated', { refused, windows: rateLimiter.size() });
    } catch (err) {
      logger.error('reaper failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }, REAP_INTERVAL_MS);
  reaper.unref();

  logger.info('relay listening', {
    port: server.port,
    publicUrl: config.publicUrl,
    env: config.nodeEnv,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reaper);
    logger.info('shutdown requested', { signal });
    // Stop accepting connections, then drain. `true` closes active sockets so
    // keep-alive connections can't hold the process open past the timeout.
    void server.stop(true).then(() => {
      db.close();
      logger.info('shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('forced shutdown after timeout');
      process.exit(1);
    }, 5000).unref();
  };
  const onSigint = () => shutdown('SIGINT');
  const onSigterm = () => shutdown('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return {
    server,
    stop: async () => {
      clearInterval(reaper);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await server.stop(true);
      db.close();
    },
  };
}

// Only when run as the program. Importing this module — which a test does, to
// check the server it builds — must not start one.
if (import.meta.main) {
  try {
    main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'startup failed', err: message }) + '\n',
    );
    process.exit(1);
  }
}
