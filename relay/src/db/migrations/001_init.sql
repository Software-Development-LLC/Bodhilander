-- 001_init.sql — initial relay schema (Milestone 1).
--
-- All timestamps are INTEGER unix milliseconds. Public keys are raw bytes
-- (BLOB). `sessions.id` stores the SHA-256 hex of the bearer cookie token, so
-- the raw token never touches the database.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  primary_email TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_identities (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ed25519_pubkey BLOB NOT NULL UNIQUE,
  x25519_pubkey BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS link_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  machine_name TEXT NOT NULL,
  ed25519_pubkey BLOB NOT NULL,
  x25519_pubkey BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_machines_user_id ON machines(user_id);
CREATE INDEX IF NOT EXISTS idx_link_codes_expires_at ON link_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
