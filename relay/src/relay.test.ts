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

describe('loadConfig — the VAPID keypair', () => {
  /** A well-formed pair: an uncompressed P-256 point, and a 32-byte scalar. */
  const publicKey = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString('base64url');
  const privateKey = Buffer.alloc(32, 2).toString('base64url');

  test('is optional, and its absence is not a warning even in production', () => {
    // Minting a pair and storing it is the supported default; warning about it
    // on every boot of the documented setup is noise nobody still reads.
    const { config, warnings } = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64) });
    expect(config.vapidPublicKey).toBeNull();
    expect(config.vapidPrivateKey).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  test('passes a well-formed pair through untouched', () => {
    const { config } = loadConfig({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey });
    expect(config.vapidPublicKey).toBe(publicKey);
    expect(config.vapidPrivateKey).toBe(privateKey);
  });

  test.each([
    ['only the public half', { VAPID_PUBLIC_KEY: publicKey }],
    ['only the private half', { VAPID_PRIVATE_KEY: privateKey }],
  ])('refuses %s rather than silently ignoring it', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  test.each([
    ['a compressed point', Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 1)]).toString('base64url'), privateKey],
    ['a short point', Buffer.alloc(32, 1).toString('base64url'), privateKey],
    ['a short scalar', publicKey, Buffer.alloc(16, 2).toString('base64url')],
  ])('refuses %s at startup, not at first send', (_label, pub, priv) => {
    // A key that only fails when a push is attempted fails invisibly, hours
    // later, on a path nobody is watching.
    expect(() => loadConfig({ VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv })).toThrow(ConfigError);
  });

  test('defaults the subject, and takes one when given', () => {
    expect(loadConfig({}).config.vapidSubject).toBe('mailto:admin@localhost');
    expect(loadConfig({ VAPID_SUBJECT: 'mailto:ops@x.test' }).config.vapidSubject).toBe('mailto:ops@x.test');
  });
});

describe('openDb / migrations', () => {
  test('runs migrations to the latest version and creates the schema', () => {
    const db = openDb(':memory:');
    try {
      const { user_version } = db.query('PRAGMA user_version;').get() as { user_version: number };
      expect(user_version).toBe(5);

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
        'handoff_bundles',
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

describe('http router: PWA statics', () => {
  const { config } = loadConfig({});
  const logger = createLogger('error');
  const repos = createRepositories(openDb(':memory:'));
  const route = createRouter({ config, logger, repos });

  interface Manifest {
    display: string;
    start_url: string;
    scope: string;
    theme_color: string;
    background_color: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  }
  const manifest = async () =>
    (await (await route(new Request('http://relay.test/manifest.webmanifest'))).json()) as Manifest;

  test('GET /manifest.webmanifest declares a standalone app at the root scope', async () => {
    const res = await route(new Request('http://relay.test/manifest.webmanifest'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
    const m = (await res.json()) as Manifest;
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  test('manifest colors match the theme-color metas in the shell', async () => {
    const m = await manifest();
    const html = await (await route(new Request('http://relay.test/'))).text();
    const metas = [...html.matchAll(/name="theme-color" content="([^"]+)"/g)].map((x) => x[1]);
    expect(metas).toContain(m.theme_color);
    expect(metas).toContain(m.background_color);
  });

  test('every manifest icon and the apple-touch-icon are served as real PNGs', async () => {
    const m = await manifest();
    for (const src of [...m.icons.map((i) => i.src), '/apple-touch-icon.png']) {
      const res = await route(new Request(`http://relay.test${src}`));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });

  test('GET /sw.js serves the worker as javascript, uncached so updates are found', async () => {
    const res = await route(new Request('http://relay.test/sw.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  test('GET /offline.html serves the branded fallback in both themes', async () => {
    const res = await route(new Request('http://relay.test/offline.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain("Can't reach the relay");
    expect(html).toContain('prefers-color-scheme: light');
  });

  test('the shell links the manifest, the worker scope-critical files and the iOS icon', async () => {
    const html = await (await route(new Request('http://relay.test/'))).text();
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('apple-mobile-web-app-capable');
  });

  test('paths next to the statics still refuse — the allow-list holds', async () => {
    for (const p of ['/icons/icon-999.png', '/icons/', '/manifest.json', '/sw.js.map', '/offline']) {
      const res = await route(new Request(`http://relay.test${p}`));
      expect(res.status).toBe(404);
    }
  });

  test('non-GET requests to the statics refuse too', async () => {
    const res = await route(new Request('http://relay.test/sw.js', { method: 'POST' }));
    expect(res.status).toBe(404);
  });
});
