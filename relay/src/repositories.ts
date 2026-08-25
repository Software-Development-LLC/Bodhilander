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
  /**
   * The GitHub handle. Distinct from `display_name`, which prefers the
   * profile's free-text name — sharing needs an identifier the account holder
   * cannot set to impersonate someone the owner trusts. NULL for users who
   * have not signed in since migration 003.
   */
  github_login: string | null;
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
  /** The handle, e.g. `dana-k`. */
  login: string;
  email: string | null;
  avatarUrl: string | null;
}

export type ClaimResult =
  | { ok: true; machine: Machine }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' };

export interface MachineGrant {
  id: string;
  machine_id: string;
  grantee_user_id: string;
  invite_id: string | null;
  /** Signed by the desktop; opaque here. NULL until the agent countersigns. */
  certificate: string | null;
  role: 'viewer' | 'operator';
  label: string | null;
  status: 'pending' | 'active' | 'revoked';
  created_at: number;
  bound_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  /** Carried from the invite so the agent can size the certificate it mints. */
  grant_ttl_seconds: number | null;
}

/**
 * How a user reaches a machine.
 *
 * `none` covers "no such machine" as well as "not yours" on purpose: telling
 * the two apart would turn the socket into an oracle for which machine ids
 * exist.
 */
export type MachineAccess =
  | { relation: 'owner'; machine: Machine }
  | { relation: 'grantee'; machine: Machine; grant: MachineGrant }
  | { relation: 'none' };

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
  purgeExpiredLinkCodes(): number;

  listMachines(userId: string): Machine[];
  getMachine(id: string): Machine | null;
  findMachineByEd25519(ed25519: Uint8Array): Machine | null;
  touchMachine(id: string): void;

  /**
   * Whether `userId` may open a channel to `machineId`, and on what basis.
   * Replaces the bare `machine.user_id !== userId` check — this answer only
   * decides whether a socket is worth brokering; the agent re-derives every
   * capability from the certificate it signed.
   */
  getMachineAccess(machineId: string, userId: string): MachineAccess;

  /**
   * Why a former guest no longer gets in: the ending their most recent grant
   * met. Null for someone who never held one — a stranger must stay
   * indistinguishable from one asking about a machine that does not exist.
   */
  endedGrantReason(machineId: string, userId: string): 'revoked' | 'expired' | null;

  // --- sharing (M5.2) ---

  createShareInvite(input: CreateShareInviteInput): { invite: ShareInvite; code: string };
  listShareInvites(machineId: string): ShareInvite[];
  revokeShareInvite(machineId: string, inviteId: string): boolean;
  /**
   * Redeem a code, creating a pending grant for `userId`.
   *
   * The grant is created here but carries no certificate: until the owner's
   * agent countersigns it, `getMachineAccess` will not honour it. Redeeming is
   * asking, not entering.
   */
  redeemShareInvite(code: string, user: User, grantId: string): RedeemResult;

  getGrant(grantId: string): MachineGrant | null;
  listGrantsForMachine(machineId: string): MachineGrant[];
  listGrantsForUser(userId: string): MachineGrant[];
  /** Attach the agent's countersigned certificate and activate the grant. */
  bindGrantCertificate(grantId: string, certificate: string, expiresAt: number): boolean;
  revokeGrant(grantId: string): boolean;
  touchGrant(grantId: string): void;
  /** Grants the next purge will drop — so their live sockets can be cut first. */
  listDeadShareGrants(): MachineGrant[];
  /** Expired or revoked grants and dead invites, dropped by the reaper. */
  purgeDeadShares(): number;

  // --- web push (M5.3) ---

  /** Small durable server-side settings. Today: the minted VAPID keypair. */
  getKv(key: string): string | null;
  setKv(key: string, value: string): void;

  /**
   * Record a browser's push subscription, replacing the keys if that endpoint
   * is already known.
   *
   * Returns null when the user is already at `MAX_PUSH_SUBSCRIPTIONS_PER_USER`
   * — a refusal, not an error: the alternative is an unbounded table filled by
   * anyone able to script a browser.
   */
  upsertPushSubscription(userId: string, input: PushSubscriptionInput): PushSubscription | null;
  listPushSubscriptions(userId: string): PushSubscription[];
  getPushSubscription(id: string): PushSubscription | null;
  deletePushSubscription(id: string): boolean;
  /** Scoped by user so an endpoint alone cannot unsubscribe someone else. */
  deletePushSubscriptionByEndpoint(userId: string, endpoint: string): boolean;
}

export interface PushSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  /** The subscription's public key, base64url — an uncompressed P-256 point. */
  p256dh: string;
  /** The subscription's 16-byte auth secret, base64url. */
  auth: string;
  created_at: number;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Per-account ceiling on stored subscriptions. A person has a handful of
 * devices; anything past this is churn (a browser that re-subscribes with a
 * fresh endpoint on every profile wipe) or abuse.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20;

export interface ShareInvite {
  id: string;
  machine_id: string;
  code_hash: string;
  expected_github_login: string | null;
  role: 'viewer' | 'operator';
  label: string | null;
  grant_ttl_seconds: number;
  status: 'pending' | 'redeemed' | 'revoked';
  redeemed_by: string | null;
  redeemed_at: number | null;
  attempt_count: number;
  created_at: number;
  expires_at: number;
}

export interface CreateShareInviteInput {
  machineId: string;
  /** NULL is an open link; a login binds redemption to that account. */
  expectedGithubLogin: string | null;
  role: 'viewer' | 'operator';
  label: string | null;
  grantTtlSeconds: number;
  /** How long the *invite* is valid, distinct from the grant it produces. */
  inviteTtlSeconds: number;
}

export type RedeemResult =
  | { ok: true; grant: MachineGrant; invite: ShareInvite }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'expired'
        | 'already_used'
        | 'revoked'
        | 'wrong_account'
        | 'own_machine'
        /** Addressed invite, and this user's GitHub handle is not on file yet. */
        | 'login_unknown';
    };

/** Thrown inside the redemption transaction to roll it back on a lost race. */
class RedeemRaceError extends Error {
  // Named so it is identifiable in a stack trace or a log line, not just via
  // `instanceof` at the one place that catches it today.
  override name = 'RedeemRaceError';
}

export function createRepositories(db: RelayDb, now: () => number = Date.now): Repositories {
  return {
    upsertGithubUser(profile) {
      const existing = db
        .query('SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?')
        .get('github', profile.providerUserId) as { user_id: string } | null;

      if (existing) {
        // Refresh mutable profile fields on each login.
        db.query(
          'UPDATE users SET display_name = ?, primary_email = ?, avatar_url = ?, github_login = ? WHERE id = ?',
        ).run(profile.displayName, profile.email, profile.avatarUrl, profile.login, existing.user_id);
        return this.getUser(existing.user_id)!;
      }

      const user: User = {
        id: crypto.randomUUID(),
        display_name: profile.displayName,
        primary_email: profile.email,
        avatar_url: profile.avatarUrl,
        created_at: now(),
        github_login: profile.login,
      };
      db.transaction(() => {
        db.query(
          `INSERT INTO users (id, display_name, primary_email, avatar_url, created_at, github_login)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(user.id, user.display_name, user.primary_email, user.avatar_url, user.created_at, user.github_login);
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

    purgeExpiredLinkCodes() {
      // Only unclaimed rows: a completed code is the audit trail of a link and
      // is kept. Nothing deleted these before, so they accumulated forever.
      const result = db
        .query("DELETE FROM link_codes WHERE status = 'pending' AND expires_at <= ?")
        .run(now());
      return Number(result.changes ?? 0);
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

    getMachineAccess(machineId, userId) {
      const machine = this.getMachine(machineId);
      if (!machine) return { relation: 'none' };
      if (machine.user_id === userId) return { relation: 'owner', machine };

      // Only an active, unexpired grant counts. A NULL expires_at means the
      // agent has not bound a certificate yet, so there is nothing to present.
      const grant = db
        .query(
          `SELECT * FROM machine_grants
            WHERE machine_id = ? AND grantee_user_id = ? AND status = 'active'
              AND certificate IS NOT NULL AND expires_at IS NOT NULL AND expires_at > ?
            ORDER BY expires_at DESC LIMIT 1`,
        )
        .get(machineId, userId, now()) as MachineGrant | null;

      if (!grant) return { relation: 'none' };
      return { relation: 'grantee', machine, grant };
    },

    endedGrantReason(machineId, userId) {
      // The most recent grant tells the story; the reaper purging dead rows
      // bounds how long it can be told, which is acceptable — after that the
      // caller falls back to the stranger answer.
      const grant = db
        .query(
          `SELECT * FROM machine_grants
            WHERE machine_id = ? AND grantee_user_id = ?
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(machineId, userId) as MachineGrant | null;
      if (!grant) return null;
      if (grant.status === 'revoked') return 'revoked';
      if (grant.expires_at !== null && grant.expires_at <= now()) return 'expired';
      return null;
    },

    createShareInvite(input) {
      const code = generateLinkCode();
      const createdAt = now();
      const invite: ShareInvite = {
        id: crypto.randomUUID(),
        machine_id: input.machineId,
        code_hash: sha256Hex(code),
        // Stored lowercased so the case-insensitive comparison at redemption
        // is a plain equality check rather than a per-row COLLATE.
        expected_github_login: input.expectedGithubLogin?.trim().toLowerCase() || null,
        role: input.role,
        label: input.label,
        grant_ttl_seconds: input.grantTtlSeconds,
        status: 'pending',
        redeemed_by: null,
        redeemed_at: null,
        attempt_count: 0,
        created_at: createdAt,
        expires_at: createdAt + input.inviteTtlSeconds * 1000,
      };
      db.query(
        `INSERT INTO share_invites
           (id, machine_id, code_hash, expected_github_login, role, label, grant_ttl_seconds,
            status, attempt_count, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      ).run(
        invite.id,
        invite.machine_id,
        invite.code_hash,
        invite.expected_github_login,
        invite.role,
        invite.label,
        invite.grant_ttl_seconds,
        invite.created_at,
        invite.expires_at,
      );
      // The raw code is returned once and never persisted — only its hash is.
      return { invite, code };
    },

    listShareInvites(machineId) {
      return db
        .query('SELECT * FROM share_invites WHERE machine_id = ? ORDER BY created_at DESC')
        .all(machineId) as ShareInvite[];
    },

    revokeShareInvite(machineId, inviteId) {
      // Scoped by machine so an invite id alone is not enough to revoke
      // someone else's invite.
      const result = db
        .query("UPDATE share_invites SET status = 'revoked' WHERE id = ? AND machine_id = ? AND status = 'pending'")
        .run(inviteId, machineId);
      return Number(result.changes ?? 0) > 0;
    },

    redeemShareInvite(code, user, grantId) {
      const row = db.query('SELECT * FROM share_invites WHERE code_hash = ?').get(sha256Hex(code)) as
        | ShareInvite
        | null;
      if (!row) return { ok: false, reason: 'not_found' };

      // Count the attempt whatever the outcome, so guessing is visible.
      db.query('UPDATE share_invites SET attempt_count = attempt_count + 1 WHERE id = ?').run(row.id);

      if (row.status === 'revoked') return { ok: false, reason: 'revoked' };
      if (row.status === 'redeemed') return { ok: false, reason: 'already_used' };
      if (row.expires_at <= now()) return { ok: false, reason: 'expired' };

      const machine = this.getMachine(row.machine_id);
      if (!machine) return { ok: false, reason: 'not_found' };
      // Redeeming your own machine's invite would create a grant that shadows
      // ownership with something narrower. Nothing good comes of it.
      if (machine.user_id === user.id) return { ok: false, reason: 'own_machine' };

      if (row.expected_github_login) {
        const login = user.github_login?.trim().toLowerCase();
        // A NULL login can never match: a user who has not signed in since
        // migration 003 must not silently satisfy an addressed invite. But it
        // is not evidence that this is the wrong person either, and answering
        // as though it were told the RIGHT person the link was not for them,
        // with no hint that signing in again is all it takes. Fail closed on
        // both, distinguish the cause.
        if (!login) return { ok: false, reason: 'login_unknown' };
        if (login !== row.expected_github_login) return { ok: false, reason: 'wrong_account' };
      }

      const ts = now();
      const grant = db.transaction(() => {
        // The `status = 'pending'` guard is repeated HERE, in SQL, rather than
        // resting on the JS check above. That check is only safe because this
        // method has no await and Bun cannot interleave two redemptions of the
        // same code — which is a property of the runtime, not of the
        // invariant. Enforced at the row, it holds regardless.
        const claimed = db
          .query(
            `UPDATE share_invites SET status = 'redeemed', redeemed_by = ?, redeemed_at = ?
              WHERE id = ? AND status = 'pending'`,
          )
          .run(user.id, ts, row.id);
        if (Number(claimed.changes ?? 0) === 0) throw new RedeemRaceError();
        db.query(
          `INSERT INTO machine_grants
             (id, machine_id, grantee_user_id, invite_id, certificate, role, label, status,
              created_at, grant_ttl_seconds)
           VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending', ?, ?)`,
        ).run(grantId, row.machine_id, user.id, row.id, row.role, row.label, ts, row.grant_ttl_seconds);
        return db.query('SELECT * FROM machine_grants WHERE id = ?').get(grantId) as MachineGrant;
      });

      let grantRow: MachineGrant;
      try {
        grantRow = grant();
      } catch (err) {
        // Lost the race: someone else redeemed this code first. Same answer
        // they would have got a moment later.
        if (err instanceof RedeemRaceError) return { ok: false, reason: 'already_used' };
        throw err;
      }

      return { ok: true, grant: grantRow, invite: { ...row, status: 'redeemed', redeemed_by: user.id, redeemed_at: ts } };
    },

    getGrant(grantId) {
      return (db.query('SELECT * FROM machine_grants WHERE id = ?').get(grantId) as MachineGrant | null) ?? null;
    },

    listGrantsForMachine(machineId) {
      return db
        .query("SELECT * FROM machine_grants WHERE machine_id = ? AND status != 'revoked' ORDER BY created_at DESC")
        .all(machineId) as MachineGrant[];
    },

    listGrantsForUser(userId) {
      return db
        .query("SELECT * FROM machine_grants WHERE grantee_user_id = ? AND status != 'revoked' ORDER BY created_at DESC")
        .all(userId) as MachineGrant[];
    },

    bindGrantCertificate(grantId, certificate, expiresAt) {
      // Only a pending grant may be bound. Re-binding an active one would let
      // a replayed `share:bind` swap the certificate under a live guest, and
      // re-binding a revoked one would resurrect it.
      const result = db
        .query(
          `UPDATE machine_grants SET certificate = ?, expires_at = ?, status = 'active', bound_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(certificate, expiresAt, now(), grantId);
      return Number(result.changes ?? 0) > 0;
    },

    revokeGrant(grantId) {
      const result = db
        .query("UPDATE machine_grants SET status = 'revoked', revoked_at = ? WHERE id = ? AND status != 'revoked'")
        .run(now(), grantId);
      return Number(result.changes ?? 0) > 0;
    },

    touchGrant(grantId) {
      db.query('UPDATE machine_grants SET last_used_at = ? WHERE id = ?').run(now(), grantId);
    },

    listDeadShareGrants() {
      // Read the rows the next purge will drop, so the caller can cut their
      // live sockets first. Otherwise a grant whose TTL elapsed would keep
      // streaming until something else noticed.
      const ts = now();
      return db
        .query(
          "SELECT * FROM machine_grants WHERE status = 'revoked' OR (expires_at IS NOT NULL AND expires_at <= ?)",
        )
        .all(ts) as MachineGrant[];
    },

    purgeDeadShares() {
      // Revoked grants go too: the DESKTOP is the authority on revocation and
      // keeps its own record, so nothing here is the audit trail. Redeemed
      // invites are kept while their grant lives, via the FK.
      const ts = now();
      const grants = db
        .query("DELETE FROM machine_grants WHERE status = 'revoked' OR (expires_at IS NOT NULL AND expires_at <= ?)")
        .run(ts);
      const invites = db
        .query("DELETE FROM share_invites WHERE status != 'redeemed' AND expires_at <= ?")
        .run(ts);
      return Number(grants.changes ?? 0) + Number(invites.changes ?? 0);
    },

    // --- web push (M5.3) ---

    getKv(key) {
      const row = db.query('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | null;
      return row?.value ?? null;
    },

    setKv(key, value) {
      db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        value,
      );
    },

    upsertPushSubscription(userId, input) {
      const existing = db.query('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(input.endpoint) as
        | PushSubscription
        | null;

      if (existing) {
        // Re-subscribing refreshes the keys and takes ownership: a browser that
        // signs in as someone else keeps the same endpoint, and leaving the row
        // pointed at the previous account would send that account's alerts to a
        // device it no longer belongs to.
        db.query('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE id = ?').run(
          userId,
          input.p256dh,
          input.auth,
          existing.id,
        );
        return { ...existing, user_id: userId, p256dh: input.p256dh, auth: input.auth };
      }

      const count = db.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as {
        n: number;
      };
      if (count.n >= MAX_PUSH_SUBSCRIPTIONS_PER_USER) return null;

      const row: PushSubscription = {
        id: crypto.randomUUID(),
        user_id: userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        created_at: now(),
      };
      db.query(
        'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.user_id, row.endpoint, row.p256dh, row.auth, row.created_at);
      return row;
    },

    listPushSubscriptions(userId) {
      return db
        .query('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at')
        .all(userId) as PushSubscription[];
    },

    getPushSubscription(id) {
      return (db.query('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as PushSubscription | null) ?? null;
    },

    deletePushSubscription(id) {
      return Number(db.query('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes ?? 0) > 0;
    },

    deletePushSubscriptionByEndpoint(userId, endpoint) {
      const result = db.query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
      return Number(result.changes ?? 0) > 0;
    },
  };
}

/** bun:sqlite binds Buffer/Uint8Array as BLOB; normalize to Buffer for binding. */
function toBuf(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
