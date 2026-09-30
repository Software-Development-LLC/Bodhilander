/**
 * An account's OAuth tokens: reading them, refreshing them the way the CLI
 * does, and writing the rotation back without losing anything else in the file.
 *
 * Run with: bun test src/main/__tests__/usage-credentials.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  FetchLike,
  isTokenExpired,
  OAUTH_CLIENT_ID,
  OAUTH_TOKEN_URL,
  readOAuthCredentials,
  refreshOAuthToken,
  TokenRefreshError,
  writeRotatedTokens,
} from '../usage-credentials';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-creds-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeCreds(oauth: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth, ...extra }));
}

const baseOauth = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 1000,
  refreshTokenExpiresAt: 5000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
};

function respond(status: number, body: unknown): { calls: { url: string; body: unknown }[]; fetch: FetchLike } {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
  };
  return { calls, fetch };
}

describe('readOAuthCredentials', () => {
  test('reads the claudeAiOauth block', () => {
    writeCreds(baseOauth);
    expect(readOAuthCredentials(dir)).toEqual({
      accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1000, scopes: ['user:inference', 'user:profile'],
    });
  });

  test('no file, a torn file, or no access token is null', () => {
    expect(readOAuthCredentials(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":');
    expect(readOAuthCredentials(dir)).toBeNull();
    writeCreds({ refreshToken: 'r' });
    expect(readOAuthCredentials(dir)).toBeNull();
  });
});

test('expiry is judged a minute early, and an unknown expiry is not expired', () => {
  const creds = { accessToken: 'a', refreshToken: 'r', scopes: [] };
  expect(isTokenExpired({ ...creds, expiresAt: 100_000 }, 50_000)).toBe(true);
  expect(isTokenExpired({ ...creds, expiresAt: 200_000 }, 50_000)).toBe(false);
  expect(isTokenExpired({ ...creds, expiresAt: null }, 50_000)).toBe(false);
});

describe('refreshOAuthToken', () => {
  const creds = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1000, scopes: ['user:inference', 'user:profile'] };

  test('sends the CLI\'s body to the CLI\'s endpoint', async () => {
    const { calls, fetch } = respond(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    const rotated = await refreshOAuthToken(creds, fetch, () => 10_000);
    expect(calls).toEqual([{
      url: OAUTH_TOKEN_URL,
      body: { grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: OAUTH_CLIENT_ID, scope: 'user:inference user:profile' },
    }]);
    expect(rotated).toEqual({
      accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 10_000 + 3600_000, scopes: null, refreshTokenExpiresAt: null,
    });
  });

  test('a response without a new refresh token keeps the old one', async () => {
    const { fetch } = respond(200, { access_token: 'new-access', expires_in: 60 });
    expect((await refreshOAuthToken(creds, fetch)).refreshToken).toBe('old-refresh');
  });

  test('a rejection carries its status and no token', async () => {
    const { fetch } = respond(400, { error: 'invalid_grant' });
    const err = await refreshOAuthToken(creds, fetch).catch(e => e);
    expect(err).toBeInstanceOf(TokenRefreshError);
    expect(err.status).toBe(400);
    expect(String(err.message)).not.toContain('old-refresh');
  });

  test('a malformed success is a failure', async () => {
    const { fetch } = respond(200, { token: 'x' });
    await expect(refreshOAuthToken(creds, fetch)).rejects.toBeInstanceOf(TokenRefreshError);
  });

  test('no refresh token means no request', async () => {
    const { calls, fetch } = respond(200, {});
    await expect(refreshOAuthToken({ ...creds, refreshToken: null }, fetch)).rejects.toBeInstanceOf(TokenRefreshError);
    expect(calls).toHaveLength(0);
  });
});

describe('writeRotatedTokens', () => {
  test('replaces the tokens and keeps every other field', () => {
    writeCreds(baseOauth, { mcpOAuth: { server: { token: 'keep' } } });
    expect(writeRotatedTokens(dir, {
      accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 9999, scopes: ['user:inference'], refreshTokenExpiresAt: 7777,
    })).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf-8'));
    expect(saved).toEqual({
      claudeAiOauth: {
        ...baseOauth,
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 9999, scopes: ['user:inference'], refreshTokenExpiresAt: 7777,
      },
      mcpOAuth: { server: { token: 'keep' } },
    });
    expect(fs.readdirSync(dir)).toEqual(['.credentials.json']);
  });

  test('refuses a file it cannot parse, leaving it untouched', () => {
    fs.writeFileSync(path.join(dir, '.credentials.json'), 'torn');
    expect(writeRotatedTokens(dir, { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: null, refreshTokenExpiresAt: null })).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf-8')).toBe('torn');
  });
});
