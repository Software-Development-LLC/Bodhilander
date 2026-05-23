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
