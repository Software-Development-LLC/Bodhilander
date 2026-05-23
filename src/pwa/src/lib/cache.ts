/**
 * Offline cache for sessions + chat events (BDHLNDR-59).
 *
 * Mom-and-Dad's iPhone is going to be on subway WiFi, in the car, in airplane
 * mode, etc. The PWA needs to render *something* the moment they open it,
 * not a spinner with a "Failed to load" error five seconds later. So we
 * persist the last-known session list and the last N chat events per session
 * into IndexedDB; on open, the views seed React Query / local state from the
 * cache and then refresh from the network in the background.
 *
 * Two stores in the shared `bodhilander` IndexedDB:
 *
 *   - `sessions_cache` — single row (`id = 'snapshot'`) holding the last
 *     session list + group list. Single-row because the desktop returns both
 *     as one logical unit per render, and there's no per-session row to
 *     update independently.
 *
 *   - `chat_events_cache` — one row per `sessionId`, holding the most recent
 *     events for that session. Capped at `EVENTS_CAP_PER_SESSION` so a noisy
 *     session can't blow out the device's quota (Safari is notoriously stingy
 *     with PWA IDB quota).
 *
 * Eviction (LRU-ish, capped):
 *   - `chat_events_cache` is trimmed to the last `EVENTS_CAP_PER_SESSION`
 *     events on every write (eager, cheap).
 *   - The number of sessions cached is capped at `SESSIONS_CAP` via
 *     `evictOldSessions()`, called opportunistically after writes (cheap
 *     count → only does work when over cap).
 *
 * Invalidation:
 *   - `clearAllCaches()` is called from `auth.ts:clearAuth()`. Re-pairing on
 *     a shared device must not leak the previous user's sessions.
 *
 * Schema bump (DB v2 → v3): owned here. Both `auth.ts` and `install-prompt.ts`
 * mirror `DB_VERSION = 3` so whichever module wins the race to open the DB
 * triggers the same upgrade path. The upgrade callback handles every
 * starting version (0, 1, 2 → 3) defensively so a fresh install that arrives
 * after v3 ships gets all four stores in one shot.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { Group, PersistedChatEvent, Session } from './types';

const DB_NAME = 'bodhilander';
/**
 * v3 = added `sessions_cache` + `chat_events_cache` (BDHLNDR-59).
 * v2 = added `install_prompt` (BDHLNDR-61).
 * v1 = `auth` (BDHLNDR-54).
 *
 * Mirrored in `auth.ts:DB_VERSION` and `install-prompt.ts:DB_VERSION`.
 */
const DB_VERSION = 3;

const AUTH_STORE = 'auth';
const PROMPT_STORE = 'install_prompt';
const SESSIONS_STORE = 'sessions_cache';
const EVENTS_STORE = 'chat_events_cache';

const SESSIONS_ROW_ID = 'snapshot';

/** Most-recent events kept per session. Phones get unhappy past a few hundred. */
const EVENTS_CAP_PER_SESSION = 200;
/** Max number of sessions we cache events for. LRU by `fetched_at`. */
const SESSIONS_CAP = 50;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface SessionsCacheRow {
  id: typeof SESSIONS_ROW_ID;
  sessions: Session[];
  groups: Group[];
  /** ms-epoch when this snapshot was written. Used for "Last updated X ago". */
  fetched_at: number;
}

export interface ChatEventsCacheRow {
  sessionId: string;
  events: PersistedChatEvent[];
  /**
   * `timestamp` of the newest cached event (ms-epoch). Used as `since` for
   * the incremental REST refresh — we never re-fetch events older than this.
   * Zero when the cached event list is empty.
   */
  last_ts: number;
  /** ms-epoch when this row was last written. Used for LRU eviction. */
  fetched_at: number;
}

interface BodhilanderDB extends DBSchema {
  [AUTH_STORE]: {
    key: string;
    // Owned by `auth.ts:AuthRecord`; opaque from this module's POV.
    value: unknown;
  };
  [PROMPT_STORE]: {
    key: string;
    // Owned by `install-prompt.ts:InstallState`; opaque from this module's POV.
    value: unknown;
  };
  [SESSIONS_STORE]: {
    key: string;
    value: SessionsCacheRow;
  };
  [EVENTS_STORE]: {
    key: string;
    value: ChatEventsCacheRow;
  };
}

// ---------------------------------------------------------------------------
// DB open + upgrade
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBPDatabase<BodhilanderDB>> | null = null;

function getDB(): Promise<IDBPDatabase<BodhilanderDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BodhilanderDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Stepwise / idempotent. Every `if` guards with `objectStoreNames`
        // so a fresh-install v0→v3 jump and a v2→v3 upgrade both land in the
        // same final shape.
        if (oldVersion < 1 && !db.objectStoreNames.contains(AUTH_STORE)) {
          db.createObjectStore(AUTH_STORE, { keyPath: 'id' });
        }
        if (oldVersion < 2 && !db.objectStoreNames.contains(PROMPT_STORE)) {
          db.createObjectStore(PROMPT_STORE, { keyPath: 'id' });
        }
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
            db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(EVENTS_STORE)) {
            db.createObjectStore(EVENTS_STORE, { keyPath: 'sessionId' });
          }
        }
      },
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Sessions cache
// ---------------------------------------------------------------------------

/**
 * Read the cached session-list snapshot, or null if we've never written one
 * (fresh install) or IndexedDB threw (private browsing / locked-down).
 * Read failures are swallowed because "no cache" is the correct fallback —
 * the view will just show a spinner and wait for the network.
 */
export async function getCachedSessions(): Promise<SessionsCacheRow | null> {
  try {
    const db = await getDB();
    const row = await db.get(SESSIONS_STORE, SESSIONS_ROW_ID);
    return row ?? null;
  } catch (err) {
    console.error('[cache] Failed to read sessions cache:', err);
    return null;
  }
}

/**
 * Overwrite the cached session-list snapshot. Called from `SessionList`
 * after each successful `fetchSessions`/`fetchGroups` pair so the cache
 * tracks the latest known state.
 *
 * Writes are best-effort — if IDB throws we log and continue rather than
 * surfacing an error into the UI. The next successful write recovers.
 */
export async function setCachedSessions(
  sessions: Session[],
  groups: Group[],
): Promise<void> {
  try {
    const db = await getDB();
    const row: SessionsCacheRow = {
      id: SESSIONS_ROW_ID,
      sessions,
      groups,
      fetched_at: Date.now(),
    };
    await db.put(SESSIONS_STORE, row);
  } catch (err) {
    console.error('[cache] Failed to write sessions cache:', err);
  }
}

// ---------------------------------------------------------------------------
// Chat events cache
// ---------------------------------------------------------------------------

/**
 * Read the cached event list for one session, or null if no row exists.
 */
export async function getCachedChatEvents(
  sessionId: string,
): Promise<ChatEventsCacheRow | null> {
  try {
    const db = await getDB();
    const row = await db.get(EVENTS_STORE, sessionId);
    return row ?? null;
  } catch (err) {
    console.error('[cache] Failed to read chat events cache:', err);
    return null;
  }
}

/**
 * Write the full event list for one session, dedup'd by `id` and capped at
 * `EVENTS_CAP_PER_SESSION`. The caller passes the *combined* event list (cached
 * + newly-loaded snapshot + WS frames) — we don't try to merge inside the
 * cache because the caller already owns the canonical in-memory log.
 *
 * Triggers an eviction sweep when the number of cached sessions exceeds
 * `SESSIONS_CAP`. The sweep is cheap (count + maybe a few deletes) so we
 * run it eagerly on writes rather than scheduling it.
 */
export async function setCachedChatEvents(
  sessionId: string,
  events: PersistedChatEvent[],
): Promise<void> {
  try {
    const db = await getDB();

    // Dedup by id, preserving insertion order. The caller's list is supposed
    // to be deduped already, but a defensive pass here prevents pathological
    // growth if the contract slips.
    const seen = new Set<string>();
    const deduped: PersistedChatEvent[] = [];
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      deduped.push(e);
    }

    // Cap to the last N events. Ordering: chat-events arrive in ascending
    // chronological order (REST contract + WS append), so we keep the tail.
    const capped =
      deduped.length > EVENTS_CAP_PER_SESSION
        ? deduped.slice(deduped.length - EVENTS_CAP_PER_SESSION)
        : deduped;

    const lastTs = capped.length > 0 ? capped[capped.length - 1].timestamp : 0;

    const row: ChatEventsCacheRow = {
      sessionId,
      events: capped,
      last_ts: lastTs,
      fetched_at: Date.now(),
    };
    await db.put(EVENTS_STORE, row);

    // Opportunistic eviction. Done after the write so the just-written row
    // is up-to-date in `fetched_at` and won't be the eviction victim.
    await evictOldSessions();
  } catch (err) {
    console.error('[cache] Failed to write chat events cache:', err);
  }
}

// ---------------------------------------------------------------------------
// Eviction + invalidation
// ---------------------------------------------------------------------------

/**
 * Cap `chat_events_cache` at the most recent `SESSIONS_CAP` sessions by
 * `fetched_at`. Cheap fast-path: count first, return immediately if under
 * cap. Only iterates + deletes when we're actually over.
 *
 * Lazy in the sense that we don't run on a timer — only after writes that
 * could plausibly push us over the cap.
 */
export async function evictOldSessions(): Promise<void> {
  try {
    const db = await getDB();
    const count = await db.count(EVENTS_STORE);
    if (count <= SESSIONS_CAP) return;

    // Pull all rows, sort by fetched_at desc, drop everything past the cap.
    // Cheaper than maintaining a separate index (we only do this when we're
    // already over the cap, which is uncommon).
    const all = await db.getAll(EVENTS_STORE);
    all.sort((a, b) => b.fetched_at - a.fetched_at);
    const victims = all.slice(SESSIONS_CAP);
    if (victims.length === 0) return;
    const tx = db.transaction(EVENTS_STORE, 'readwrite');
    await Promise.all([
      ...victims.map((v) => tx.store.delete(v.sessionId)),
      tx.done,
    ]);
  } catch (err) {
    console.error('[cache] Failed to evict old sessions:', err);
  }
}

/**
 * Drop everything in both caches. Called from `auth.ts:clearAuth()` so a
 * fresh pair on a shared device (Mom hands her iPhone to Dad) starts from
 * an empty cache instead of showing the previous account's sessions.
 *
 * Uses `clear()` rather than `deleteDatabase()` so the auth + install_prompt
 * stores (cleared independently by their owners) aren't disturbed and so
 * the next `openDB()` call doesn't re-trigger the upgrade callback.
 */
export async function clearAllCaches(): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction([SESSIONS_STORE, EVENTS_STORE], 'readwrite');
    await Promise.all([
      tx.objectStore(SESSIONS_STORE).clear(),
      tx.objectStore(EVENTS_STORE).clear(),
      tx.done,
    ]);
  } catch (err) {
    console.error('[cache] Failed to clear caches:', err);
  }
}
