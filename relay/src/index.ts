import { loadConfig } from './config';
import { openDb } from './db';
import { createRouter } from './http';
import { createLogger } from './logger';
import { createRepositories } from './repositories';
import { createAgentGateway, newAgentSocketData } from './ws';

function main(): void {
  const { config, warnings } = loadConfig();
  const logger = createLogger(config.logLevel);
  for (const warning of warnings) {
    logger.warn(warning);
  }

  const db = openDb(config.dbPath);
  logger.info('database ready', { path: config.dbPath });

  const repos = createRepositories(db);
  const route = createRouter({ config, logger, repos });
  const agentGateway = createAgentGateway({ repos, logger });

  const server = Bun.serve({
    port: config.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      // Agents connect here and authenticate with an Ed25519-signed nonce (see
      // src/ws.ts). Every non-/ws path is served by the HTTP router.
      if (url.pathname === '/ws') {
        if (srv.upgrade(req, { data: newAgentSocketData() })) return undefined;
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      return route(req);
    },
    websocket: agentGateway,
  });

  logger.info('relay listening', {
    port: server.port,
    publicUrl: config.publicUrl,
    env: config.nodeEnv,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
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
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'startup failed', err: message }) + '\n',
  );
  process.exit(1);
}
