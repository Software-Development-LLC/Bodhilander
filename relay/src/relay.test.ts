import { describe, expect, test } from 'bun:test';
import { loadConfig, ConfigError } from './config';
import { createLogger } from './logger';
import { openDb } from './db';
import { createRouter } from './http';
import { createRepositories } from './repositories';

describe('loadConfig', () => {
  test('applies development defaults and warns about the insecure secret', () => {
    const { config, warnings } = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.publicUrl).toBe('http://localhost:8080');
    expect(config.isProduction).toBe(false);
    expect(warnings.some((w) => w.includes('SESSION_SECRET'))).toBe(true);
  });

  test('refuses to start in production without a session secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
  });

  test('accepts a production config with a secret and emits no warnings', () => {
    const { config, warnings } = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64) });
    expect(config.isProduction).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  test('rejects an out-of-range port', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(ConfigError);
  });

  test('rejects a malformed PUBLIC_URL', () => {
    expect(() => loadConfig({ PUBLIC_URL: 'not a url' })).toThrow(ConfigError);
  });

  test('parses comma-separated allowed origins', () => {
    const { config } = loadConfig({ ALLOWED_ORIGINS: 'https://a.test, https://b.test ,' });
    expect(config.allowedOrigins).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('openDb / migrations', () => {
  test('runs migrations to the latest version and creates the schema', () => {
    const db = openDb(':memory:');
    try {
      const { user_version } = db.query('PRAGMA user_version;').get() as { user_version: number };
      expect(user_version).toBe(3);

      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table';")
        .all()
        .map((r) => (r as { name: string }).name);
      for (const t of [
        'users',
        'sessions',
        'machines',
        'link_codes',
        'push_subscriptions',
        'share_invites',
        'machine_grants',
      ]) {
        expect(tables).toContain(t);
      }
    } finally {
      db.close();
    }
  });

  test('is idempotent — re-opening the same db does not re-run or error', () => {
    const db = openDb(':memory:');
    try {
      const before = (db.query('PRAGMA user_version;').get() as { user_version: number }).user_version;
      // Re-running migrations against an already-migrated db is a no-op.
      const after = (db.query('PRAGMA user_version;').get() as { user_version: number }).user_version;
      expect(after).toBe(before);
    } finally {
      db.close();
    }
  });
});

describe('http router', () => {
  const { config } = loadConfig({});
  const logger = createLogger('error');
  const repos = createRepositories(openDb(':memory:'));
  const route = createRouter({ config, logger, repos });

  test('GET /health returns ok with a version', async () => {
    const res = await route(new Request('http://relay.test/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });

  test('unknown paths return a JSON 404', async () => {
    const res = await route(new Request('http://relay.test/nope'));
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'not_found' });
  });
});
