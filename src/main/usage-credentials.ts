import * as fs from 'fs';
import * as path from 'path';

/**
 * The OAuth tokens in an account's `.credentials.json`, and refreshing them the
 * way the CLI does. Nothing here logs a token, and errors carry only a status.
 * The endpoint, client id and body shape are copied from the CLI binary.
 */

export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const CREDENTIALS_FILE = '.credentials.json';

/** What the CLI asks for when a refresh token carries no recorded scopes. */
export const DEFAULT_OAUTH_SCOPES: readonly string[] = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
  'user:plugins',
];

/** Refresh a little early, so a token does not expire between check and use. */
const EXPIRY_SKEW_MS = 60_000;

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms, or null when the file does not say. */
  expiresAt: number | null;
  scopes: string[];
}

export interface RotatedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[] | null;
  refreshTokenExpiresAt: number | null;
}

export function credentialsPath(configDir: string): string {
  return path.join(configDir, CREDENTIALS_FILE);
}

export function readRaw(configDir: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(configDir), 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** The tokens in a credentials document, or null when it holds none. */
export function oauthFromDocument(doc: Record<string, unknown> | null): OAuthCredentials | null {
  const oauth = doc?.claudeAiOauth as Record<string, unknown> | undefined;
  if (typeof oauth?.accessToken !== 'string' || oauth.accessToken === '') return null;
  return {
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === 'string' && oauth.refreshToken ? oauth.refreshToken : null,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((s): s is string => typeof s === 'string') : [],
  };
}

/** The account's tokens, or null when there is no readable token file. */
export function readOAuthCredentials(configDir: string): OAuthCredentials | null {
  return oauthFromDocument(readRaw(configDir));
}

/**
 * The document with the rotated pair folded in and every other field kept, or
 * null without one, or when it no longer holds the refresh token the pair replaced.
 */
export function withRotatedTokens(
  doc: Record<string, unknown> | null,
  rotated: RotatedTokens,
  spent: string | null,
): Record<string, unknown> | null {
  const oauth = doc?.claudeAiOauth;
  if (!doc || typeof oauth !== 'object' || oauth === null) return null;
  if (oauthFromDocument(doc)?.refreshToken !== spent) return null;
  const next: Record<string, unknown> = {
    ...(oauth as Record<string, unknown>),
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt,
  };
  if (rotated.scopes) next.scopes = rotated.scopes;
  if (rotated.refreshTokenExpiresAt !== null) next.refreshTokenExpiresAt = rotated.refreshTokenExpiresAt;
  return { ...doc, claudeAiOauth: next };
}

export function isTokenExpired(creds: OAuthCredentials, now: number): boolean {
  return creds.expiresAt !== null && creds.expiresAt - EXPIRY_SKEW_MS <= now;
}

export class TokenRefreshError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? 'Token refresh failed' : `Token refresh failed (${status})`);
    this.name = 'TokenRefreshError';
  }
}

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

/** Exchange the refresh token for a new pair, with the CLI's own request body. */
export async function refreshOAuthToken(
  creds: OAuthCredentials,
  fetchImpl: FetchLike,
  now: () => number = Date.now,
): Promise<RotatedTokens> {
  if (!creds.refreshToken) throw new TokenRefreshError(null);
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  };
  body.scope = (creds.scopes.length > 0 ? creds.scopes : DEFAULT_OAUTH_SCOPES).join(' ');

  let response: Awaited<ReturnType<FetchLike>>;
  let data: unknown;
  try {
    response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new TokenRefreshError(response.status);
    data = await response.json();
  } catch (err) {
    if (err instanceof TokenRefreshError) throw err;
    throw new TokenRefreshError(null);
  }

  const fields = (data ?? {}) as Record<string, unknown>;
  if (typeof fields.access_token !== 'string' || typeof fields.expires_in !== 'number') {
    throw new TokenRefreshError(response.status);
  }
  const issuedAt = now();
  return {
    accessToken: fields.access_token,
    refreshToken: typeof fields.refresh_token === 'string' ? fields.refresh_token : creds.refreshToken,
    expiresAt: issuedAt + fields.expires_in * 1000,
    scopes: typeof fields.scope === 'string' ? fields.scope.split(' ').filter(Boolean) : null,
    refreshTokenExpiresAt: typeof fields.refresh_token_expires_in === 'number'
      ? issuedAt + fields.refresh_token_expires_in * 1000
      : null,
  };
}

/**
 * Write rotated tokens back, keeping every other field. Refuses a file it
 * cannot parse, and replaces it by temp file + rename so the CLI never reads a
 * torn one.
 */
export function writeRotatedTokens(
  configDir: string,
  rotated: RotatedTokens,
  spent: string | null,
  rename: (from: string, to: string) => void = fs.renameSync,
): boolean {
  const doc = withRotatedTokens(readRaw(configDir), rotated, spent);
  if (!doc) return false;

  const file = credentialsPath(configDir);
  const tmp = `${file}.bodhilander.tmp`;
  const text = JSON.stringify(doc);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rename(tmp, file);
      return true;
    } catch { /* Windows refuses a rename over a file another process has open */ }
  }
  try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
  // The old refresh token is already spent, so a torn-read risk beats losing the pair.
  try {
    fs.writeFileSync(file, text, { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
