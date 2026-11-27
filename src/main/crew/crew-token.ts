/**
 * How Crew runs sign in for one account. The Crew token ships only once S2
 * probe 16 holds; until then, and wherever safeStorage cannot encrypt, runs
 * use the account's own login, with a reminder before it is due to end.
 */
import type Database from 'better-sqlite3';
import { writeAudit } from './audit';

/** Off until S2 probe 16 holds on macOS and Windows. */
export const CREW_TOKEN_SHIPS = false;
export const TOKEN_LIFETIME_MS = 365 * 24 * 3_600_000;
export const TOKEN_REMIND_DAYS = [14, 2] as const;
/** Subscription logins have needed signing in again about every 7 days; probe 7 has not measured it yet. */
export const LOGIN_LIFETIME_MS = 7 * 24 * 3_600_000;
export const LOGIN_REMIND_BEFORE_MS = 24 * 3_600_000;

const DAY_MS = 24 * 3_600_000;
const TOKEN_PREFIX = 'sk-ant-oat01-';
const TOKEN_BODY = /^[A-Za-z0-9_-]+$/;

export type SignInMode = 'token' | 'login';

export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

export interface Reminder {
  accountId: string;
  mode: SignInMode;
  /** When the sign-in is due to end, epoch ms. */
  endsAt: number;
  /** `token-14`, `token-2` or `login`: each is sent once per sign-in. */
  key: string;
}

interface Row {
  id: string;
  crew_token_enc: string | null;
  crew_token_created_at: string | null;
  crew_token_expires_at: string | null;
  crew_signed_in_at: string | null;
  crew_auth_failed_at: string | null;
  crew_reminded: string | null;
}

/** The lines a run prints when its sign-in is gone; probe 16 records the exact set. */
const AUTH_FAILURES = [
  /this sign-in may have ended/i,
  /failed to authenticate/i,
  /oauth (session|token) (has )?(expired|been revoked|is invalid)/i,
  /invalid (api key|bearer token|oauth token)/i,
];

export function isAuthFailure(line: string): boolean {
  if (AUTH_FAILURES.some((re) => re.test(line))) return true;
  return /\b401\b/.test(line) && /unauthori[sz]ed|authentication/i.test(line);
}

/** The one token line from setup-token's output; nothing else is kept. */
export function extractToken(output: string): string | null {
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(TOKEN_PREFIX) && TOKEN_BODY.test(line.slice(TOKEN_PREFIX.length))) return line;
  }
  return null;
}

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? null : n;
};

function remindedKeys(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const keys: unknown = JSON.parse(stored);
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export class CrewSignIn {
  constructor(
    private readonly db: Database.Database,
    private readonly cipher: Cipher,
    private readonly tokenShips: boolean = CREW_TOKEN_SHIPS,
  ) {}

  mode(): SignInMode {
    return this.tokenShips && this.cipher.isEncryptionAvailable() ? 'token' : 'login';
  }

  private row(accountId: string): Row | null {
    return (
      (this.db
        .prepare(
          `SELECT id, crew_token_enc, crew_token_created_at, crew_token_expires_at, crew_signed_in_at, crew_auth_failed_at, crew_reminded
           FROM claude_accounts WHERE id = ?`,
        )
        .get(accountId) as Row | undefined) ?? null
    );
  }

  /** Can a run start on this account now. `loggedIn` is account-identity's login evidence. */
  signedIn(accountId: string, loggedIn: boolean | undefined, now: number): boolean {
    const row = this.row(accountId);
    if (!row || row.crew_auth_failed_at !== null) return false;
    if (this.mode() === 'login') return loggedIn !== false;
    const expires = ms(row.crew_token_expires_at);
    return row.crew_token_enc !== null && expires !== null && expires > now;
  }

  /** Login evidence seen for an account with no recorded sign-in: the reminder counts from now. */
  observeLogin(accountId: string, loggedIn: boolean | undefined, now: number): void {
    if (loggedIn !== true) return;
    this.db
      .prepare(`UPDATE claude_accounts SET crew_signed_in_at = ? WHERE id = ? AND crew_signed_in_at IS NULL`)
      .run(new Date(now).toISOString(), accountId);
  }

  /** Sign in again finished: the login's clock restarts and an auth-failure hold lifts. */
  recordSignIn(accountId: string, now: number): void {
    this.db
      .prepare(`UPDATE claude_accounts SET crew_signed_in_at = ?, crew_auth_failed_at = NULL, crew_reminded = NULL WHERE id = ?`)
      .run(new Date(now).toISOString(), accountId);
    writeAudit(this.db, null, 'crew-signed-in', { accountId, mode: 'login' });
  }

  /** A run reported its sign-in gone. Held until a new token or a new login. */
  recordAuthFailure(accountId: string, now: number): void {
    this.db.prepare(`UPDATE claude_accounts SET crew_auth_failed_at = ? WHERE id = ?`).run(new Date(now).toISOString(), accountId);
    writeAudit(this.db, null, 'crew-auth-failed', { accountId, mode: this.mode() });
  }

  /**
   * Store a token from setup-token's output once `belongsTo` confirms it is this
   * account's. Returns why it was refused, or null when stored.
   */
  storeToken(
    accountId: string,
    output: string,
    belongsTo: (token: string) => boolean,
    now: number,
    expiresAt: number | null = null,
  ): 'no-token' | 'wrong-account' | 'no-encryption' | null {
    if (!this.cipher.isEncryptionAvailable()) return 'no-encryption';
    const token = extractToken(output);
    if (token === null) return 'no-token';
    if (!belongsTo(token)) {
      writeAudit(this.db, null, 'crew-token-wrong-account', { accountId });
      return 'wrong-account';
    }
    const enc = this.cipher.encryptString(token).toString('base64');
    const expires = expiresAt ?? now + TOKEN_LIFETIME_MS;
    this.db
      .prepare(
        `UPDATE claude_accounts SET crew_token_enc = ?, crew_token_created_at = ?, crew_token_expires_at = ?,
           crew_auth_failed_at = NULL, crew_reminded = NULL WHERE id = ?`,
      )
      .run(enc, new Date(now).toISOString(), new Date(expires).toISOString(), accountId);
    writeAudit(this.db, null, 'crew-signed-in', { accountId, mode: 'token' });
    return null;
  }

  removeToken(accountId: string): void {
    this.db
      .prepare(`UPDATE claude_accounts SET crew_token_enc = NULL, crew_token_created_at = NULL, crew_token_expires_at = NULL WHERE id = ?`)
      .run(accountId);
    writeAudit(this.db, null, 'crew-token-removed', { accountId });
  }

  /** The token for a run's descriptor 3, or null. Never logged. */
  tokenFor(accountId: string, now: number): string | null {
    if (this.mode() !== 'token' || !this.signedIn(accountId, true, now)) return null;
    const row = this.row(accountId);
    try {
      return this.cipher.decryptString(Buffer.from(row!.crew_token_enc!, 'base64'));
    } catch {
      return null;
    }
  }

  /** When this account's Crew sign-in is due to end, or null when nothing is recorded. */
  endsAt(accountId: string): number | null {
    const row = this.row(accountId);
    if (!row) return null;
    if (this.mode() === 'token') return ms(row.crew_token_expires_at);
    const signedIn = ms(row.crew_signed_in_at);
    return signedIn === null ? null : signedIn + LOGIN_LIFETIME_MS;
  }

  /** Reminders now due, each marked sent so it fires once per sign-in. */
  dueReminders(accountId: string, now: number): Reminder[] {
    const row = this.row(accountId);
    const endsAt = this.endsAt(accountId);
    if (!row || endsAt === null || now >= endsAt) return [];
    const mode = this.mode();
    const sent = new Set<string>(remindedKeys(row.crew_reminded));
    const marks =
      mode === 'token'
        ? TOKEN_REMIND_DAYS.map((d) => ({ key: `token-${d}`, at: endsAt - d * DAY_MS }))
        : [{ key: 'login', at: endsAt - LOGIN_REMIND_BEFORE_MS }];
    const due = marks.filter((m) => now >= m.at && !sent.has(m.key));
    if (due.length === 0) return [];
    for (const m of marks) if (now >= m.at) sent.add(m.key);
    this.db.prepare(`UPDATE claude_accounts SET crew_reminded = ? WHERE id = ?`).run(JSON.stringify([...sent]), accountId);
    return [{ accountId, mode, endsAt, key: due[due.length - 1].key }];
  }
}
