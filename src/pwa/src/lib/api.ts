/**
 * Minimal fetch wrapper for the Bodhilander REST API.
 *
 * Token loading is delegated to `./auth.ts` (IndexedDB-backed, wired in
 * BDHLNDR-54). Call sites import `apiFetch` and `getAuthToken` from here;
 * neither cares where the token actually lives.
 *
 * Contract (from BDHLNDR-51):
 *   - Bearer token in the `Authorization` header for paired devices.
 *   - All endpoints are namespaced under `/api/v1/...`.
 */

import { getAuth } from './auth';
import type { Group, PersistedChatEvent, Session } from './types';

const API_BASE = '/api/v1';

/**
 * Resolve the current device bearer token, or null if the PWA isn't paired.
 * Reads from IndexedDB via `getAuth()` so the result survives reloads and
 * matches whatever the user paired with on the desktop.
 */
export async function getAuthToken(): Promise<string | null> {
  const auth = await getAuth();
  return auth?.token ?? null;
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Issue a JSON request against `/api/v1/...`. Throws ApiError on non-2xx.
 *
 * @param path   Path relative to /api/v1 (e.g. `/sessions`).
 * @param opts   Standard fetch options. `body`, if provided, is JSON-encoded.
 */
export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiRequestOptions = {},
): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(opts.headers);
  headers.set('Accept', 'application/json');
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // non-JSON error body — ignore, surface status only.
    }
    throw new ApiError(`API request failed: ${res.status}`, res.status, body);
  }

  // 204 No Content
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Typed REST helpers (BDHLNDR-55)
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/sessions — list every session the desktop knows about.
 *
 * Server returns `{ sessions: Session[] }`; we unwrap so call sites can
 * pass the array straight into React Query without dealing with the
 * envelope. Dates arrive as ISO strings (see `./types.ts`).
 */
export async function fetchSessions(): Promise<Session[]> {
  const { sessions } = await apiFetch<{ sessions: Session[] }>('/sessions');
  return sessions;
}

/**
 * GET /api/v1/groups — list every group. Same unwrap pattern as
 * `fetchSessions`. Used by the session-list grouping UI.
 */
export async function fetchGroups(): Promise<Group[]> {
  const { groups } = await apiFetch<{ groups: Group[] }>('/groups');
  return groups;
}

// ---------------------------------------------------------------------------
// Chat events (BDHLNDR-56)
// ---------------------------------------------------------------------------

export interface ChatEventsPage {
  events: PersistedChatEvent[];
  nextSince: number | null;
  hasMore: boolean;
}

export interface FetchChatEventsParams {
  /** ms-epoch — server returns events strictly newer than this. */
  since?: number;
  /** Default 100, max 500. */
  limit?: number;
}

/**
 * GET /api/v1/sessions/:id/chat-events — persisted snapshot of the chat log.
 * Ascending chronological order. 404 on unknown sessionId surfaces as ApiError.
 *
 * Used by the PWA chat view (BDHLNDR-56) for the initial render before live
 * WS updates start streaming in.
 */
export async function fetchChatEvents(
  sessionId: string,
  params: FetchChatEventsParams = {},
): Promise<ChatEventsPage> {
  const query = new URLSearchParams();
  if (params.since !== undefined) query.set('since', String(params.since));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  const path = `/sessions/${encodeURIComponent(sessionId)}/chat-events${qs ? `?${qs}` : ''}`;
  return apiFetch<ChatEventsPage>(path);
}

/**
 * POST /api/v1/terminal/:id/input — send literal bytes to the PTY.
 * 403 (no canControl perm) bubbles up as ApiError; the chat view surfaces
 * that inline as "Read-only" feedback.
 */
export async function sendTerminalInput(sessionId: string, data: string): Promise<void> {
  await apiFetch<{ success: true }>(
    `/terminal/${encodeURIComponent(sessionId)}/input`,
    { method: 'POST', body: { data } },
  );
}

