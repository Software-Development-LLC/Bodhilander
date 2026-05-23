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

const DB_NAME = 'bodhilander';
// BDHLNDR-61: bumped 1 → 2 to add the `install_prompt` store. The schema
// change itself is owned by `install-prompt.ts` (this file's upgrade callback
// only creates the `auth` store at v1); the version number just has to agree
// across every module that opens the DB, otherwise the second `openDB` call
// throws a `VersionError`. If you bump again, mirror the new version in
// `install-prompt.ts:DB_VERSION`.
const DB_VERSION = 2;
const STORE_NAME = 'auth';
const ROW_ID = 'current';

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
}

let dbPromise: Promise<IDBPDatabase<BodhilanderDB>> | null = null;

function getDB(): Promise<IDBPDatabase<BodhilanderDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BodhilanderDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
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
 */
export async function clearAuth(): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, ROW_ID);
}
