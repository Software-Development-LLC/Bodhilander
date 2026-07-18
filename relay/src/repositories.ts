import type { RelayDb } from './db';
import { generateLinkCode, randomToken, sha256Hex } from './crypto';

/**
 * Typed data-access layer over the M1 schema (`db/migrations/001_init.sql`).
 * All timestamps are unix milliseconds. Bearer secrets (session tokens, link
 * codes) are only ever stored as their SHA-256 hash — the raw value is returned
 * to the caller once, at creation, and never persisted.
 */

export interface User {
  id: string;
  display_name: string;
  primary_email: string | null;
  avatar_url: string | null;
  created_at: number;
}

export interface Machine {
  id: string;
  user_id: string;
  name: string;
  ed25519_pubkey: Uint8Array;
  x25519_pubkey: Uint8Array;
  created_at: number;
  last_seen_at: number | null;
}

export interface GithubProfile {
  providerUserId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export type ClaimResult =
  | { ok: true; machine: Machine }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' };

export interface Repositories {
  upsertGithubUser(profile: GithubProfile): User;
  getUser(id: string): User | null;

  createSession(userId: string, ttlSeconds: number): { token: string; expiresAt: number };
  getUserBySessionToken(token: string): User | null;
  deleteSession(token: string): void;
  purgeExpiredSessions(): void;

  createLinkCode(
    machineName: string,
    ed25519: Uint8Array,
    x25519: Uint8Array,
    ttlSeconds: number,
  ): { code: string; expiresAt: number };
  claimLinkCode(code: string, userId: string): ClaimResult;

  listMachines(userId: string): Machine[];
  getMachine(id: string): Machine | null;
  findMachineByEd25519(ed25519: Uint8Array): Machine | null;
  touchMachine(id: string): void;
}

export function createRepositories(db: RelayDb, now: () => number = Date.now): Repositories {
  return {
    upsertGithubUser(profile) {
      const existing = db
        .query('SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?')
        .get('github', profile.providerUserId) as { user_id: string } | null;

      if (existing) {
        // Refresh mutable profile fields on each login.
        db.query('UPDATE users SET display_name = ?, primary_email = ?, avatar_url = ? WHERE id = ?').run(
          profile.displayName,
          profile.email,
          profile.avatarUrl,
          existing.user_id,
        );
        return this.getUser(existing.user_id)!;
      }

      const user: User = {
        id: crypto.randomUUID(),
        display_name: profile.displayName,
        primary_email: profile.email,
        avatar_url: profile.avatarUrl,
        created_at: now(),
      };
      db.transaction(() => {
        db.query(
          'INSERT INTO users (id, display_name, primary_email, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(user.id, user.display_name, user.primary_email, user.avatar_url, user.created_at);
        db.query(
          'INSERT INTO oauth_identities (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)',
        ).run('github', profile.providerUserId, user.id, user.created_at);
      })();
      return user;
    },

    getUser(id) {
      return (db.query('SELECT * FROM users WHERE id = ?').get(id) as User | null) ?? null;
    },

    createSession(userId, ttlSeconds) {
      const token = randomToken();
      const createdAt = now();
      const expiresAt = createdAt + ttlSeconds * 1000;
      db.query('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
        sha256Hex(token),
        userId,
        createdAt,
        expiresAt,
      );
      return { token, expiresAt };
    },

    getUserBySessionToken(token) {
      const row = db
        .query(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = ? AND s.expires_at > ?`,
        )
        .get(sha256Hex(token), now()) as User | null;
      return row ?? null;
    },

    deleteSession(token) {
      db.query('DELETE FROM sessions WHERE id = ?').run(sha256Hex(token));
    },

    purgeExpiredSessions() {
      db.query('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    },

    createLinkCode(machineName, ed25519, x25519, ttlSeconds) {
      const code = generateLinkCode();
      const createdAt = now();
      const expiresAt = createdAt + ttlSeconds * 1000;
      db.query(
        `INSERT INTO link_codes
           (id, code_hash, machine_name, ed25519_pubkey, x25519_pubkey, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(crypto.randomUUID(), sha256Hex(code), machineName, toBuf(ed25519), toBuf(x25519), createdAt, expiresAt);
      return { code, expiresAt };
    },

    claimLinkCode(code, userId) {
      const row = db.query('SELECT * FROM link_codes WHERE code_hash = ?').get(sha256Hex(code)) as
        | {
            id: string;
            machine_name: string;
            ed25519_pubkey: Uint8Array;
            x25519_pubkey: Uint8Array;
            status: string;
            expires_at: number;
          }
        | null;

      if (!row) return { ok: false, reason: 'not_found' };
      if (row.status === 'completed') return { ok: false, reason: 'already_used' };
      if (row.expires_at <= now()) return { ok: false, reason: 'expired' };

      const machine = db.transaction(() => {
        db.query("UPDATE link_codes SET status = 'completed', user_id = ? WHERE id = ?").run(userId, row.id);

        // Re-linking an already-registered identity rebinds it to this user
        // rather than failing the UNIQUE(ed25519_pubkey) constraint.
        const prior = db
          .query('SELECT id FROM machines WHERE ed25519_pubkey = ?')
          .get(toBuf(row.ed25519_pubkey)) as { id: string } | null;

        const ts = now();
        if (prior) {
          db.query(
            'UPDATE machines SET user_id = ?, name = ?, x25519_pubkey = ?, last_seen_at = ? WHERE id = ?',
          ).run(userId, row.machine_name, toBuf(row.x25519_pubkey), ts, prior.id);
          return db.query('SELECT * FROM machines WHERE id = ?').get(prior.id) as Machine;
        }
        const id = crypto.randomUUID();
        db.query(
          `INSERT INTO machines (id, user_id, name, ed25519_pubkey, x25519_pubkey, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, userId, row.machine_name, toBuf(row.ed25519_pubkey), toBuf(row.x25519_pubkey), ts, ts);
        return db.query('SELECT * FROM machines WHERE id = ?').get(id) as Machine;
      })();

      return { ok: true, machine };
    },

    listMachines(userId) {
      return db
        .query('SELECT * FROM machines WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId) as Machine[];
    },

    getMachine(id) {
      return (db.query('SELECT * FROM machines WHERE id = ?').get(id) as Machine | null) ?? null;
    },

    findMachineByEd25519(ed25519) {
      return (db.query('SELECT * FROM machines WHERE ed25519_pubkey = ?').get(toBuf(ed25519)) as Machine | null) ?? null;
    },

    touchMachine(id) {
      db.query('UPDATE machines SET last_seen_at = ? WHERE id = ?').run(now(), id);
    },
  };
}

/** bun:sqlite binds Buffer/Uint8Array as BLOB; normalize to Buffer for binding. */
function toBuf(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
