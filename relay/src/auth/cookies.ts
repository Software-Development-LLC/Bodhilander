/**
 * Cookie parsing/serialization for the relay. Session and OAuth-state cookies
 * are HttpOnly + SameSite=Lax; Secure is toggled by the caller (on in
 * production / behind a TLS proxy).
 */

export const SESSION_COOKIE = 'bdl_session';
export const OAUTH_STATE_COOKIE = 'bdl_oauth_state';

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure: boolean;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.httpOnly ?? true) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join('; ');
}

/** A Set-Cookie value that immediately expires `name`. */
export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', { secure, maxAgeSeconds: 0 });
}
