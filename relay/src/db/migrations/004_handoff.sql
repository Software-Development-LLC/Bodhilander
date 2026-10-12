-- 004_handoff.sql — the machine-handoff drop box.
--
-- The relay is a courier here, not a reader: `ciphertext` is sealed on the old
-- machine with a key derived from a phrase that never leaves it. Nothing in
-- this table, and nothing anywhere else in this database, opens it.
--
-- `user_id` is UNIQUE rather than indexed, so "one bundle per user at a time"
-- is a schema guarantee instead of a rule the upload path has to remember: an
-- upload is an upsert on that key and replaces whatever was there.
--
-- New file rather than an edit to 003: `runMigrations` skips any version not
-- greater than the current `user_version`, so editing an applied migration is
-- a silent no-op on every existing database.

CREATE TABLE IF NOT EXISTS handoff_bundles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- Which machine prepared it, so the destination can name the offer. Dropping
  -- the source machine drops the offer: an unlinked machine's state is no
  -- longer something this user is being invited to adopt.
  source_machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  ciphertext BLOB NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_bundles_expires_at ON handoff_bundles(expires_at);
