/**
 * IndexedDB-backed auth/token store for the mobile PWA.
 *
 * The PWA stores a single auth row (id = 'current') containing the device
 * bearer token returned by `POST /api/v1/pairing/confirm` and the device
 * metadata the desktop sent back. IndexedDB survives reloads, installs as
 * a "real app" via the PWA manifest, and works offline — exactly what we
 * need so the user doesn't have to re-pair every time.
 *
 * Wire-up (BDHLNDR-54):
 *   - `Pair.tsx` calls `saveAuth(token, device)` after a successful confirm.
 *   - `api.ts:getAuthToken()` reads from here so all REST calls carry the
 *     Authorization header.
 *   - `App.tsx:<RequireAuth>` reads from here to gate `/sessions/*`.
 *   - The unpair button in SessionList calls `clearAuth()` after the
 *     server-side DELETE succeeds.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import { clearAllCaches } from './cache';

const DB_NAME = 'bodhilander';
// BDHLNDR-59: bumped 2 → 3 to add `sessions_cache` + `chat_events_cache`.
// BDHLNDR-61: bumped 1 → 2 to add the `install_prompt` store.
// Schema changes for v2/v3 are owned by their respective modules
// (`install-prompt.ts`, `cache.ts`); this file's upgrade callback only
// creates the `auth` store at v1. The version number just has to agree
// across every module that opens the DB, otherwise the second `openDB` call
// throws a `VersionError`. If you bump again, mirror the new version in
// `install-prompt.ts:DB_VERSION` AND `cache.ts:DB_VERSION`, and extend the
// defensive upgrade callbacks in both peer files to cover the new schema.
const DB_VERSION = 3;
const STORE_NAME = 'auth';
const ROW_ID = 'current';
// New cache stores added in v3 (BDHLNDR-59). We defensively create them
// here too so whichever module wins the open-DB race lands at the same
// final shape.
const SESSIONS_CACHE_STORE = 'sessions_cache';
const CHAT_EVENTS_CACHE_STORE = 'chat_events_cache';
const PROMPT_STORE = 'install_prompt';

/**
 * Subset of the device payload the desktop returns from
 * `POST /api/v1/pairing/confirm` plus the platform string the PWA itself
 * sent (the desktop echoes it back via `GET /pairing/devices`, but not on
 * confirm, so we re-attach it here to keep the row self-describing).
 */
export interface AuthDevice {
  id: string;
  name: string;
  platform: string;
  canControl: boolean;
  canModify: boolean;
}

export interface AuthRecord {
  id: typeof ROW_ID;
  token: string;
  device: AuthDevice;
  paired_at: number;
}

interface BodhilanderDB extends DBSchema {
  [STORE_NAME]: {
    key: string;
    value: AuthRecord;
  };
  // Peer stores — typed as `unknown` so we don't reach into other modules'
  // row shapes from here. Each owner module declares its own DBSchema with
  // the proper types; idb tolerates the loose declaration as long as the
  // names match.
  [PROMPT_STORE]: { key: string; value: unknown };
  [SESSIONS_CACHE_STORE]: { key: string; value: unknown };
  [CHAT_EVENTS_CACHE_STORE]: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<BodhilanderDB>> | null = null;

function getDB(): Promise<IDBPDatabase<BodhilanderDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BodhilanderDB>(DB_NAME, DB_VERSION, {
      // Defensive upgrade — handles v0→v3 (fresh install after v3 ships),
      // v1→v3 (user on the original BDHLNDR-54 build), v2→v3 (user on the
      // BDHLNDR-61 build). Whichever module wins the open-DB race runs an
      // identical upgrade path; the `if (!contains)` guards make every
      // createObjectStore idempotent.
      upgrade(db, oldVersion) {
        if (oldVersion < 1 && !db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
        if (oldVersion < 2 && !db.objectStoreNames.contains(PROMPT_STORE)) {
          db.createObjectStore(PROMPT_STORE, { keyPath: 'id' });
        }
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains(SESSIONS_CACHE_STORE)) {
            db.createObjectStore(SESSIONS_CACHE_STORE, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(CHAT_EVENTS_CACHE_STORE)) {
            db.createObjectStore(CHAT_EVENTS_CACHE_STORE, { keyPath: 'sessionId' });
          }
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Persist a fresh auth record after a successful pair. Overwrites any
 * existing row — re-pairing on the same device is the explicit reset path.
 */
export async function saveAuth(token: string, device: AuthDevice): Promise<void> {
  const db = await getDB();
  const record: AuthRecord = {
    id: ROW_ID,
    token,
    device,
    paired_at: Date.now(),
  };
  await db.put(STORE_NAME, record);
}

/**
 * Read the current auth row, or null if the PWA has never paired (or the
 * user just unpaired).
 */
export async function getAuth(): Promise<AuthRecord | null> {
  try {
    const db = await getDB();
    const record = await db.get(STORE_NAME, ROW_ID);
    return record ?? null;
  } catch (err) {
    // IndexedDB can throw in private-browsing / locked-down contexts.
    // Treat as "no auth" so the UI falls through to /pair instead of
    // hanging on a thrown promise.
    console.error('[auth] Failed to read IndexedDB:', err);
    return null;
  }
}

/**
 * Wipe the auth row. Called after the desktop confirms unpair so the PWA
 * forgets the (now-invalid) token and bounces back to /pair.
 *
 * Also drops the offline session/event caches (BDHLNDR-59) — a re-pair on
 * a shared device must not leak the previous user's sessions or chat log.
 * Cache clear runs after auth delete and is best-effort (own try/catch
 * inside `clearAllCaches`), so a cache failure can't leave the auth row
 * stranded.
 */
export async function clearAuth(): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, ROW_ID);
  await clearAllCaches();
}
