/**
 * web_fetch's own checks (design §5.7): public https on 443, every resolved
 * address normalised and refused when it is not public, the checked address
 * dialled, redirects followed by hand with each hop checked again.
 */
import * as dns from 'dns';
import * as https from 'https';
import * as net from 'net';

export const FETCH_TIMEOUT_MS = 20_000;
export const FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 5;

export interface FetchResponse {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
}

export interface FetchTransport {
  lookup(host: string): Promise<string[]>;
  /** One GET to `address`, with `url`'s host for SNI and the certificate. Rejects past maxBytes. */
  get(url: URL, address: string, maxBytes: number, signal: AbortSignal): Promise<FetchResponse>;
}

export type FetchResult = { ok: true; url: string; text: string } | { ok: false; reason: string };

function v4Bytes(a: string): number[] | null {
  if (net.isIPv4(a)) return a.split('.').map(Number);
  return null;
}

function v6Bytes(a: string): number[] | null {
  if (!net.isIPv6(a) || a.includes('%')) return null;
  let s = a;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    tail.push(...(v4Bytes(dotted[1]) ?? []));
    s = `${s.slice(0, -dotted[1].length)}0:0`;
  }
  const [head, rest] = s.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  const groups = [...left, ...fill, ...right].map((g) => parseInt(g, 16));
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

function v4Public(b: number[]): boolean {
  const [x, y] = b;
  if (x === 0 || x === 10 || x === 127 || x >= 224) return false;
  if (x === 100 && y >= 64 && y < 128) return false;
  if (x === 169 && y === 254) return false;
  if (x === 172 && y >= 16 && y < 32) return false;
  if (x === 192 && y === 168) return false;
  return true;
}

const zero = (b: number[], from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);

/** Whether a resolved address is public. Mapped and well-known-prefix NAT64 addresses are judged as their IPv4. */
export function addressAllowed(address: string): boolean {
  const v4 = v4Bytes(address);
  if (v4) return v4Public(v4);
  const b = v6Bytes(address);
  if (!b) return false;
  if (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Public(b.slice(12));
  if (zero(b, 0, 12)) return false;
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return zero(b, 4, 12) && v4Public(b.slice(12));
  if ((b[0] & 0xfe) === 0xfc) return false;
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false;
  if (b[0] === 0xff) return false;
  return true;
}

const hostOf = (u: URL): string => u.hostname.replace(/^\[|\]$/g, '').toLowerCase();

function urlProblem(u: URL): string | null {
  if (u.protocol !== 'https:') return 'web_fetch fetches https only.';
  if (u.port !== '' && u.port !== '443') return 'web_fetch fetches on port 443 only.';
  if (u.username || u.password) return 'web_fetch does not send credentials in a URL.';
  return null;
}

const listed = (host: string, hosts: readonly string[]): boolean => hosts.some((h) => h.toLowerCase() === host);

async function checkedAddress(u: URL, transport: FetchTransport): Promise<string | null> {
  const host = hostOf(u);
  const addresses = net.isIP(host) ? [host] : await transport.lookup(host);
  if (addresses.length === 0 || !addresses.every(addressAllowed)) return null;
  return addresses[0];
}

const TEXT_TYPE = /^(text\/[\w.+-]+|application\/xhtml\+xml)\s*(;|$)/i;

/**
 * Fetch one page. `tainted` is the run's state when the call started; the
 * call's own redirect hops never change it.
 */
export async function fetchPage(raw: unknown, tainted: boolean, fetchHosts: readonly string[], transport: FetchTransport, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchResult> {
  let url: URL;
  try {
    url = new URL(typeof raw === 'string' ? raw : '');
  } catch {
    return { ok: false, reason: 'url must be an absolute https URL.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      const problem = urlProblem(url);
      if (problem) return { ok: false, reason: problem };
      if (tainted && !listed(hostOf(url), fetchHosts)) {
        const list = fetchHosts.length ? fetchHosts.join(', ') : 'no host';
        return { ok: false, reason: `This run has read untrusted content, so it can only fetch from ${list}.` };
      }
      const address = await checkedAddress(url, transport);
      if (!address) return { ok: false, reason: `${hostOf(url)} is not a public address.` };
      const res = await transport.get(url, address, FETCH_MAX_BYTES, controller.signal);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (!res.location) return { ok: false, reason: 'A redirect had no location.' };
        url = new URL(res.location, url);
        continue;
      }
      if (res.status < 200 || res.status >= 300) return { ok: false, reason: `The page answered ${res.status}.` };
      if (!TEXT_TYPE.test(res.contentType)) return { ok: false, reason: 'web_fetch reads text and HTML only.' };
      if (res.body.length > FETCH_MAX_BYTES) return { ok: false, reason: 'The page is over 5 MB.' };
      return { ok: true, url: url.href, text: res.body.toString('utf8') };
    }
    return { ok: false, reason: `More than ${FETCH_MAX_REDIRECTS} redirects.` };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, reason: 'The fetch took over 20 seconds.' };
    return { ok: false, reason: err instanceof TooLarge ? 'The page is over 5 MB.' : 'The page could not be fetched.' };
  } finally {
    clearTimeout(timer);
  }
}

export class TooLarge extends Error {}

/** The real transport: the dial goes to the checked address, never to a second DNS answer. */
export const httpsTransport: FetchTransport = {
  lookup: async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  get: (url, address, maxBytes, signal) =>
    new Promise((resolve, reject) => {
      const family = net.isIPv6(address) ? 6 : 4;
      const req = https.request(
        {
          host: hostOf(url),
          servername: net.isIP(hostOf(url)) ? undefined : hostOf(url),
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { 'user-agent': 'BodhiCrew-web_fetch', accept: 'text/html, text/*;q=0.9' },
          lookup: (_h, opts, cb) => (opts && (opts as { all?: boolean }).all ? cb(null, [{ address, family }] as never, family) : cb(null, address, family)),
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let n = 0;
          res.on('data', (c: Buffer) => {
            n += c.length;
            if (n > maxBytes) {
              req.destroy(new TooLarge());
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const location = res.headers.location;
            resolve({ status: res.statusCode ?? 0, location: typeof location === 'string' ? location : null, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    }),
};
