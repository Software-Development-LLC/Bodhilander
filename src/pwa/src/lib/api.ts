/**
 * Minimal fetch wrapper for the Bodhilander REST API.
 *
 * Real token loading from IndexedDB lands in BDHLNDR-54 (pair flow). For now
 * this exposes a stub `getAuthToken()` hook so call sites can be written now
 * and swapped to the real implementation without touching every call site.
 *
 * Contract (from BDHLNDR-51):
 *   - Bearer token in the `Authorization` header for paired devices.
 *   - All endpoints are namespaced under `/api/v1/...`.
 */

const API_BASE = '/api/v1';

/**
 * Stub — replaced by an IndexedDB-backed implementation in BDHLNDR-54.
 * Returns `null` today so requests go out un-authenticated and the desktop's
 * auth middleware can reject them with a clean 401 (which the UI can then
 * route to /pair). That keeps the call sites stable across tickets.
 */
export async function getAuthToken(): Promise<string | null> {
  return null;
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
