/**
 * Environment-driven configuration for the relay.
 *
 * Fail fast (ConfigError) on invalid values; warn — via the returned
 * `warnings` list — on insecure development defaults. `loadConfig` takes the
 * env map explicitly so tests can exercise it without touching `process.env`.
 */

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
  /** GitHub OAuth app credentials — consumed in M2, optional for now. */
  githubClientId: string | null;
  githubClientSecret: string | null;
  /** If set, only active members of this GitHub org may sign in (empty = open). */
  allowedGithubOrg: string | null;
  vapidSubject: string;
  /**
   * The Web Push application-server keypair, base64url, in the shape
   * `npx web-push generate-vapid-keys` prints: a raw uncompressed P-256 point
   * (65 bytes) and its scalar (32 bytes).
   *
   * Both null means "mint one on first use and keep it in the `kv` table" —
   * see `push/vapid.ts`. Supplying them matters when the relay's volume is
   * disposable, because the public key is baked into every browser
   * subscription: losing it silently orphans every subscribed device.
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

  return {
    config: {
      port,
      publicUrl,
      dbPath: env.DB_PATH ?? './data/relay.db',
      sessionSecret,
      logLevel,
      trustProxy,
      allowedOrigins,
      linkCodeTtlSeconds,
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
 * Read the VAPID keypair from the environment.
 *
 * Half a keypair is always a mistake rather than a shorthand, so it fails
 * rather than quietly ignoring the half that was set.
 *
 * Absent entirely is the supported default: the relay mints a pair on first use
 * and keeps it in the database. That is NOT warned about here, deliberately — a
 * deployment with a durable volume is entitled to it, and a warning on every
 * boot of the documented setup is one nobody would still be reading by the time
 * it mattered. The one moment worth saying something is when a pair is actually
 * minted in production, which `push/vapid.ts` does, because that is where the
 * program learns it is happening.
 */
function parseVapidKeys(env: Record<string, string | undefined>): {
  publicKey: string | null;
  privateKey: string | null;
} {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || null;
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() || null;

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
