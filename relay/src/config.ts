/**
 * Environment-driven configuration for the relay.
 *
 * Fail fast (ConfigError) on invalid values; warn — via the returned
 * `warnings` list — on insecure development defaults. `loadConfig` takes the
 * env map explicitly so tests can exercise it without touching `process.env`.
 */

import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RelayConfig {
  port: number;
  publicUrl: string;
  dbPath: string;
  sessionSecret: string;
  logLevel: LogLevel;
  trustProxy: boolean;
  /** Extra allowed web origins; empty = same-origin only. */
  allowedOrigins: string[];
  linkCodeTtlSeconds: number;
  /** How long a prepared machine handoff stays available to be restored. */
  handoffTtlSeconds: number;
  /** Ceiling on one handoff's sealed bytes. */
  handoffMaxBytes: number;
  /** Where sealed bundles are written. Beside the database, so it is on the volume. */
  handoffDir: string;
  /** Ceiling on the whole store, so one machine's cap is not the disk's. */
  handoffStoreMaxBytes: number;
  /** GitHub OAuth app credentials — consumed in M2, optional for now. */
  githubClientId: string | null;
  githubClientSecret: string | null;
  /** If set, only active members of this GitHub org may sign in (empty = open). */
  allowedGithubOrg: string | null;
  vapidSubject: string;
  /**
   * The Web Push application-server keypair, base64url. Both null means "mint
   * one and keep it in `kv`". Supply them when the volume is disposable: the
   * public key is baked into every browser subscription. See `push/vapid.ts`.
   */
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  nodeEnv: string;
  isProduction: boolean;
}

export interface LoadedConfig {
  config: RelayConfig;
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEV_SESSION_SECRET = 'dev-only-insecure-session-secret';
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function fail(message: string): never {
  throw new ConfigError(message);
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function parsePositiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseBool(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return fail(`${name} must be a boolean (true/false/1/0/yes/no), got ${JSON.stringify(raw)}`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): LoadedConfig {
  const warnings: string[] = [];

  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  const port = env.PORT ? parsePort(env.PORT) : 8080;

  const publicUrl = env.PUBLIC_URL ?? `http://localhost:${port}`;
  try {
    // Validation only — the value itself is stored verbatim.
    new URL(publicUrl);
  } catch {
    fail(`PUBLIC_URL must be a valid absolute URL, got ${JSON.stringify(publicUrl)}`);
  }

  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProduction) {
      fail('SESSION_SECRET is required when NODE_ENV=production');
    }
    sessionSecret = DEV_SESSION_SECRET;
    warnings.push(
      'SESSION_SECRET is not set — using an insecure built-in development default. ' +
        'Set SESSION_SECRET before exposing this service to a network.',
    );
  }

  const logLevelRaw = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    fail(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(logLevelRaw)}`);
  }
  const logLevel = logLevelRaw as LogLevel;

  const trustProxy = env.TRUST_PROXY ? parseBool('TRUST_PROXY', env.TRUST_PROXY) : false;

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const linkCodeTtlSeconds = env.LINK_CODE_TTL_SECONDS
    ? parsePositiveInt('LINK_CODE_TTL_SECONDS', env.LINK_CODE_TTL_SECONDS)
    : 600;

  const { publicKey: vapidPublicKey, privateKey: vapidPrivateKey } = parseVapidKeys(env);
  const handoffTtlSeconds = env.HANDOFF_TTL_SECONDS
    ? parsePositiveInt('HANDOFF_TTL_SECONDS', env.HANDOFF_TTL_SECONDS)
    : 7 * 24 * 60 * 60;

  const handoffMaxBytes = env.HANDOFF_MAX_BYTES
    ? parsePositiveInt('HANDOFF_MAX_BYTES', env.HANDOFF_MAX_BYTES)
    : 256 * 1024 * 1024;

  const handoffStoreMaxBytes = env.HANDOFF_STORE_MAX_BYTES
    ? parsePositiveInt('HANDOFF_STORE_MAX_BYTES', env.HANDOFF_STORE_MAX_BYTES)
    : 8 * 1024 * 1024 * 1024;

  const dbPath = env.DB_PATH ?? './data/relay.db';
  // Beside the database, which is what the deployment puts on a volume. An
  // in-memory database has no directory to sit beside, so the caller must say
  // where — a fixed name under the system temp directory would be a
  // world-writable path holding other people's sealed bundles, and one nobody
  // chose. Every caller here already passes HANDOFF_DIR alongside `:memory:`.
  const handoffDir =
    env.HANDOFF_DIR ??
    (dbPath === ':memory:'
      ? fail('HANDOFF_DIR must be set when DB_PATH is :memory:, since there is no database directory to sit beside')
      : path.join(path.dirname(path.resolve(dbPath)), 'handoffs'));

  return {
    config: {
      port,
      publicUrl,
      dbPath,
      sessionSecret,
      logLevel,
      trustProxy,
      allowedOrigins,
      linkCodeTtlSeconds,
      handoffTtlSeconds,
      handoffMaxBytes,
      handoffDir,
      handoffStoreMaxBytes,
      githubClientId: env.GITHUB_CLIENT_ID || null,
      githubClientSecret: env.GITHUB_CLIENT_SECRET || null,
      allowedGithubOrg: env.ALLOWED_GITHUB_ORG?.trim() || null,
      vapidSubject: env.VAPID_SUBJECT ?? 'mailto:admin@localhost',
      vapidPublicKey,
      vapidPrivateKey,
      nodeEnv,
      isProduction,
    },
    warnings,
  };
}

/** Raw uncompressed P-256 point, and the scalar that goes with it. */
const VAPID_PUBLIC_KEY_BYTES = 65;
const VAPID_PRIVATE_KEY_BYTES = 32;

function decodeBase64Url(raw: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(raw.trim(), 'base64url'));
  } catch {
    return null;
  }
}

/**
 * Read the VAPID keypair from the environment. Half a pair is a mistake, not a
 * shorthand, so it fails rather than ignoring the half that was set. Absent is
 * the supported default; `push/vapid.ts` warns at the one actionable moment.
 */
function parseVapidKeys(env: Record<string, string | undefined>): {
  publicKey: string | null;
  privateKey: string | null;
} {
  // Empty and unset are the same thing here. Written out rather than as
  // `?.trim() || null`, which reads as a `??` waiting to happen — and `??`
  // would keep the empty string, tripping the paired check below on a relay
  // that has `VAPID_PUBLIC_KEY=` in its .env and started fine yesterday.
  let publicKey: string | null = null;
  let privateKey: string | null = null;
  const rawPublic = env.VAPID_PUBLIC_KEY?.trim();
  const rawPrivate = env.VAPID_PRIVATE_KEY?.trim();
  if (rawPublic) publicKey = rawPublic;
  if (rawPrivate) privateKey = rawPrivate;

  if (!publicKey && !privateKey) return { publicKey: null, privateKey: null };
  if (!publicKey || !privateKey) {
    fail('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together');
  }

  const pub = decodeBase64Url(publicKey);
  const priv = decodeBase64Url(privateKey);
  if (!pub || pub.length !== VAPID_PUBLIC_KEY_BYTES || pub[0] !== 0x04) {
    fail(`VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 point (${VAPID_PUBLIC_KEY_BYTES} bytes, 0x04 prefix)`);
  }
  if (!priv || priv.length !== VAPID_PRIVATE_KEY_BYTES) {
    fail(`VAPID_PRIVATE_KEY must be a base64url P-256 scalar (${VAPID_PRIVATE_KEY_BYTES} bytes)`);
  }
  return { publicKey, privateKey };
}
