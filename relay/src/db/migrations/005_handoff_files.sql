-- 005_handoff_files.sql — bundles move out of the database and onto disk.
--
-- A sealed handoff is now hundreds of megabytes, and holding that in a BLOB
-- makes every read of it a whole copy in memory. Worse, SQLite does not return
-- freed pages to the filesystem, so a database that also holds sessions and
-- grants would grow to the size of the largest bundle ever stored and stay
-- there. The bytes now live in files named by `handoff_bundles.id`.
--
-- Rebuilt rather than altered: 004 is already applied wherever this branch has
-- run, and `runMigrations` skips any file not newer than `user_version`, so
-- editing it would be a silent no-op on those databases.
--
-- Any bundle stored under 004 is dropped. They are opaque, single-use and
-- expire within a week; there is nothing here worth carrying across.

DROP TABLE IF EXISTS handoff_bundles;

CREATE TABLE handoff_bundles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  source_machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_bundles_expires_at ON handoff_bundles(expires_at);
