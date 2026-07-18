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
      nodeEnv,
      isProduction,
    },
    warnings,
  };
}
