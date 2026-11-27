import { describe, expect, test } from 'bun:test';
import {
  CrewSignIn,
  LOGIN_LIFETIME_MS,
  LOGIN_REMIND_BEFORE_MS,
  TOKEN_LIFETIME_MS,
  extractToken,
  isAuthFailure,
  type Cipher,
} from '../crew-token';
import { crewDb } from './crew-db';

const DAY = 24 * 3_600_000;
const T0 = 1_700_000_000_000;
const TOKEN = 'sk-ant-oat01-AbC_d-123';

function setup(opts: { ships?: boolean; encryption?: boolean } = {}) {
  const { raw, db } = crewDb();
  raw.exec(`INSERT INTO claude_accounts (id, label, config_dir, email) VALUES ('a1', 'Work Max', '/acct/a1', 'b@x')`);
  const cipher: Cipher = {
    isEncryptionAvailable: () => opts.encryption ?? true,
    encryptString: (p) => Buffer.from(`enc:${p}`),
    decryptString: (b) => b.toString().replace(/^enc:/, ''),
  };
  const signIn = new CrewSignIn(db, cipher, opts.ships ?? true);
  const col = (c: string) => (raw.query(`SELECT ${c} AS v FROM claude_accounts WHERE id = 'a1'`).get() as { v: unknown }).v;
  const audits = () => (raw.query(`SELECT event, detail FROM crew_audit`).all() as { event: string; detail: string }[]);
  return { raw, db, signIn, col, audits };
}

describe('the sign-in mode', () => {
  test('the token path stays off until it ships, and off without encryption', () => {
    expect(setup({ ships: false }).signIn.mode()).toBe('login');
    expect(setup({ ships: true, encryption: false }).signIn.mode()).toBe('login');
    expect(setup({ ships: true }).signIn.mode()).toBe('token');
  });

  test('the shipped default is the login fallback', () => {
    const { db } = crewDb();
    const cipher = { isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
    expect(new CrewSignIn(db, cipher).mode()).toBe('login');
  });
});

describe('the login fallback', () => {
  test('signed in follows login evidence; unreadable evidence does not hold', () => {
    const t = setup({ ships: false });
    expect(t.signIn.signedIn('a1', true, T0)).toBe(true);
    expect(t.signIn.signedIn('a1', undefined, T0)).toBe(true);
    expect(t.signIn.signedIn('a1', false, T0)).toBe(false);
    expect(t.signIn.signedIn('nope', true, T0)).toBe(false);
  });

  test('an auth failure holds until Sign in again finishes', () => {
    const t = setup({ ships: false });
    t.signIn.recordAuthFailure('a1', T0);
    expect(t.signIn.signedIn('a1', true, T0)).toBe(false);
    t.signIn.recordSignIn('a1', T0 + 1000);
    expect(t.signIn.signedIn('a1', true, T0 + 1000)).toBe(true);
    expect(t.audits().map((a) => a.event)).toEqual(['crew-auth-failed', 'crew-signed-in']);
  });

  test('the first sight of a login starts its clock once; Sign in again restarts it', () => {
    const t = setup({ ships: false });
    t.signIn.observeLogin('a1', false, T0);
    expect(t.signIn.endsAt('a1')).toBeNull();
    t.signIn.observeLogin('a1', true, T0);
    t.signIn.observeLogin('a1', true, T0 + DAY);
    expect(t.signIn.endsAt('a1')).toBe(T0 + LOGIN_LIFETIME_MS);
    t.signIn.recordSignIn('a1', T0 + 2 * DAY);
    expect(t.signIn.endsAt('a1')).toBe(T0 + 2 * DAY + LOGIN_LIFETIME_MS);
  });

  test('one reminder, 24 hours before the login is due to end, and again after a new sign-in', () => {
    const t = setup({ ships: false });
    t.signIn.recordSignIn('a1', T0);
    const at = T0 + LOGIN_LIFETIME_MS - LOGIN_REMIND_BEFORE_MS;
    expect(t.signIn.dueReminders('a1', at - 1)).toEqual([]);
    expect(t.signIn.dueReminders('a1', at)).toEqual([{ accountId: 'a1', mode: 'login', endsAt: T0 + LOGIN_LIFETIME_MS, key: 'login' }]);
    expect(t.signIn.dueReminders('a1', at + 1000)).toEqual([]);
    t.signIn.recordSignIn('a1', at + 2000);
    expect(t.signIn.dueReminders('a1', at + 2000 + LOGIN_LIFETIME_MS - LOGIN_REMIND_BEFORE_MS)).toHaveLength(1);
  });

  test('a login with no recorded sign-in has no reminder, and none past its end', () => {
    const t = setup({ ships: false });
    expect(t.signIn.dueReminders('a1', T0)).toEqual([]);
    t.signIn.recordSignIn('a1', T0);
    expect(t.signIn.dueReminders('a1', T0 + LOGIN_LIFETIME_MS)).toEqual([]);
  });

  test('no token is handed to a run on the login fallback', () => {
    const t = setup({ ships: false });
    expect(t.signIn.tokenFor('a1', T0)).toBeNull();
  });
});

describe('the Crew token', () => {
  test('only the token line is kept, encrypted, with created and expiry times', () => {
    const t = setup();
    const out = `Opening browser…\r\nYour token:\r\n  ${TOKEN}  \r\nStore it safely.`;
    expect(t.signIn.storeToken('a1', out, () => true, T0)).toBeNull();
    expect(t.col('crew_token_enc')).toBe(Buffer.from(`enc:${TOKEN}`).toString('base64'));
    expect(t.col('crew_token_created_at')).toBe(new Date(T0).toISOString());
    expect(t.col('crew_token_expires_at')).toBe(new Date(T0 + TOKEN_LIFETIME_MS).toISOString());
    expect(t.signIn.tokenFor('a1', T0)).toBe(TOKEN);
    expect(JSON.stringify(t.audits())).not.toContain('sk-ant');
  });

  test('an expiry setup-token reports wins over a year from now', () => {
    const t = setup();
    t.signIn.storeToken('a1', TOKEN, () => true, T0, T0 + 30 * DAY);
    expect(t.signIn.endsAt('a1')).toBe(T0 + 30 * DAY);
  });

  test('a token for another account, output with no token, or no encryption stores nothing', () => {
    const t = setup();
    expect(t.signIn.storeToken('a1', TOKEN, () => false, T0)).toBe('wrong-account');
    expect(t.signIn.storeToken('a1', 'no token here', () => true, T0)).toBe('no-token');
    expect(t.col('crew_token_enc')).toBeNull();
    expect(setup({ encryption: false }).signIn.storeToken('a1', TOKEN, () => true, T0)).toBe('no-encryption');
  });

  test('signed in only with a stored token before its expiry, and not after an auth failure', () => {
    const t = setup();
    expect(t.signIn.signedIn('a1', true, T0)).toBe(false);
    t.signIn.storeToken('a1', TOKEN, () => true, T0, T0 + DAY);
    expect(t.signIn.signedIn('a1', false, T0)).toBe(true);
    expect(t.signIn.signedIn('a1', true, T0 + DAY)).toBe(false);
    t.signIn.storeToken('a1', TOKEN, () => true, T0, T0 + 10 * DAY);
    t.signIn.recordAuthFailure('a1', T0);
    expect(t.signIn.signedIn('a1', true, T0)).toBe(false);
    expect(t.signIn.tokenFor('a1', T0)).toBeNull();
    t.signIn.storeToken('a1', TOKEN, () => true, T0, T0 + 10 * DAY);
    expect(t.signIn.signedIn('a1', true, T0)).toBe(true);
  });

  test('reminders 14 and 2 days before expiry, each once; a late look sends only the nearer one', () => {
    const t = setup();
    t.signIn.storeToken('a1', TOKEN, () => true, T0, T0 + 30 * DAY);
    expect(t.signIn.dueReminders('a1', T0 + 15 * DAY)).toEqual([]);
    expect(t.signIn.dueReminders('a1', T0 + 16 * DAY).map((r) => r.key)).toEqual(['token-14']);
    expect(t.signIn.dueReminders('a1', T0 + 17 * DAY)).toEqual([]);
    expect(t.signIn.dueReminders('a1', T0 + 28 * DAY).map((r) => r.key)).toEqual(['token-2']);
    const late = setup();
    late.signIn.storeToken('a1', TOKEN, () => true, T0, T0 + 30 * DAY);
    expect(late.signIn.dueReminders('a1', T0 + 29 * DAY).map((r) => r.key)).toEqual(['token-2']);
    expect(late.signIn.dueReminders('a1', T0 + 29 * DAY + 1)).toEqual([]);
  });

  test('removing the token signs the account out', () => {
    const t = setup();
    t.signIn.storeToken('a1', TOKEN, () => true, T0);
    t.signIn.removeToken('a1');
    expect(t.signIn.signedIn('a1', true, T0)).toBe(false);
    expect(t.col('crew_token_enc')).toBeNull();
  });
});

describe('reading run output', () => {
  test('the sign-in-ended lines count as auth failures, ordinary errors do not', () => {
    for (const line of [
      'This sign-in may have ended between Mon and Tue',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'OAuth token has been revoked',
      'API Error: 401 Unauthorized',
    ]) {
      expect(isAuthFailure(line)).toBe(true);
    }
    for (const line of ['API Error: 500', 'file 401.txt not found', 'rate limited']) expect(isAuthFailure(line)).toBe(false);
  });

  test('extractToken takes only a whole token line', () => {
    expect(extractToken(`x\n${TOKEN}\ny`)).toBe(TOKEN);
    expect(extractToken(`prefix ${TOKEN}`)).toBeNull();
    expect(extractToken('')).toBeNull();
  });
});
