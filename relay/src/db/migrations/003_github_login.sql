-- 003_github_login.sql — persist the GitHub handle (Milestone 5.2).
--
-- The login is fetched during OAuth and then discarded: `displayName` prefers
-- the profile *name* and only falls back to the handle, so it is not the
-- handle. Sharing needs the handle itself for two things that cannot use a
-- display name:
--
--   * addressed invites, which bind `share_invites.expected_github_login` so a
--     code redeemed by anyone else fails closed;
--   * the owner's approval prompt, which must show an immutable identifier —
--     a display name is attacker-chosen and can be set to impersonate someone
--     the owner trusts.
--
-- Separate from 002 rather than an edit to it: 002 is already applied in
-- production, and `runMigrations` skips any file whose version is not greater
-- than the current `user_version`. Editing it would be a silent no-op on every
-- existing database.
--
-- Nullable with no backfill: existing users acquire it on their next sign-in.
-- Nothing may treat a NULL login as a match — see `redeemShareInvite`.

ALTER TABLE users ADD COLUMN github_login TEXT;

-- Case-insensitive, because GitHub logins are compared that way and an invite
-- addressed to `Dana-K` must match a session for `dana-k`.
CREATE INDEX IF NOT EXISTS idx_users_github_login ON users(github_login COLLATE NOCASE);
