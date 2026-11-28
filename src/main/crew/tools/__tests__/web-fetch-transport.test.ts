import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';

type LookupCb = (err: Error | null, address: unknown, family?: number) => void;
interface Captured {
  opts: Record<string, unknown> & { lookup: (host: string, opts: unknown, cb: LookupCb) => void };
  req: EventEmitter & { destroyed: boolean };
  res: EventEmitter & { statusCode: number; headers: Record<string, string> };
}

const calls: Captured[] = [];
let respond: (c: Captured) => void = () => {};

function request(opts: Captured['opts'], onResponse: (res: Captured['res']) => void) {
  const req = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy(err?: Error) {
      req.destroyed = true;
      if (err) req.emit('error', err);
    },
    end() {
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/html' } });
      const c = { opts, req, res };
      calls.push(c);
      onResponse(res);
      respond(c);
    },
  });
  return req;
}

const dnsLookups: string[] = [];
const fakeDns = {
  lookup: (host: string) => {
    dnsLookups.push(host);
    throw new Error('the transport consulted DNS on its own');
  },
  promises: {
    lookup: async (host: string) => {
      dnsLookups.push(host);
      return [{ address: '10.0.0.5', family: 4 }];
    },
  },
};
mock.module('https', () => ({ request, default: { request } }));
mock.module('node:https', () => ({ request, default: { request } }));
mock.module('dns', () => ({ ...fakeDns, default: fakeDns }));

const { httpsTransport, fetchPage, FETCH_MAX_BYTES, TooLarge } = await import('../web-fetch');

const CHECKED = '93.184.216.34';

function lookupAnswer(c: Captured, opts: unknown): Promise<{ address: unknown; family?: number }> {
  return new Promise((resolve, reject) => c.opts.lookup('example.com', opts, (err, address, family) => (err ? reject(err) : resolve({ address, family }))));
}

describe('httpsTransport', () => {
  test('dials only the address it was given, whatever DNS would answer for the host now', async () => {
    calls.length = 0;
    dnsLookups.length = 0;
    respond = ({ res }) => {
      res.emit('data', Buffer.from('<p>hi</p>'));
      res.emit('end');
    };
    const page = await httpsTransport.get(new URL('https://example.com/a?b=1'), CHECKED, FETCH_MAX_BYTES, new AbortController().signal);
    expect(page.body.toString()).toBe('<p>hi</p>');
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.opts.host).toBe('example.com');
    expect(c.opts.servername).toBe('example.com');
    expect(c.opts.port).toBe(443);
    expect(c.opts.path).toBe('/a?b=1');
    expect(typeof c.opts.lookup).toBe('function');
    expect(await lookupAnswer(c, {})).toEqual({ address: CHECKED, family: 4 });
    expect(await lookupAnswer(c, { all: true })).toEqual({ address: [{ address: CHECKED, family: 4 }], family: 4 });
    expect(dnsLookups).toEqual([]);
  });

  test('an IPv6 address is dialled as family 6', async () => {
    calls.length = 0;
    respond = ({ res }) => res.emit('end');
    await httpsTransport.get(new URL('https://example.com/'), '2606:4700::1111', FETCH_MAX_BYTES, new AbortController().signal);
    expect(await lookupAnswer(calls[0], {})).toEqual({ address: '2606:4700::1111', family: 6 });
  });

  test('stops reading a body past the cap and rejects as too large', async () => {
    calls.length = 0;
    const MB = Buffer.alloc(1024 * 1024, 0x61);
    let sent = 0;
    respond = ({ req, res }) => {
      for (let i = 0; i < 8 && !req.destroyed; i++) {
        res.emit('data', MB);
        sent++;
      }
      res.emit('end');
    };
    const got = httpsTransport.get(new URL('https://example.com/'), CHECKED, FETCH_MAX_BYTES, new AbortController().signal);
    await expect(got).rejects.toBeInstanceOf(TooLarge);
    expect(calls[0].req.destroyed).toBe(true);
    expect(sent).toBe(6);
  });

  test('a body of exactly 5 MB is read whole', async () => {
    respond = ({ res }) => {
      for (let i = 0; i < 5; i++) res.emit('data', Buffer.alloc(1024 * 1024));
      res.emit('end');
    };
    const page = await httpsTransport.get(new URL('https://example.com/'), CHECKED, FETCH_MAX_BYTES, new AbortController().signal);
    expect(page.body.length).toBe(FETCH_MAX_BYTES);
  });

  test('fetchPage over the real transport reports a page past 5 MB', async () => {
    respond = ({ req, res }) => {
      for (let i = 0; i < 6 && !req.destroyed; i++) res.emit('data', Buffer.alloc(1024 * 1024));
      res.emit('end');
    };
    expect(await fetchPage(`https://${CHECKED}/big`, false, [], httpsTransport)).toEqual({ ok: false, reason: 'The page is over 5 MB.' });
  });

  test('fetchPage resolves once through the transport and dials nothing when the answer is private', async () => {
    calls.length = 0;
    dnsLookups.length = 0;
    expect(await fetchPage('https://rebind.example/', false, [], httpsTransport)).toEqual({ ok: false, reason: 'rebind.example is not a public address.' });
    expect(dnsLookups).toEqual(['rebind.example']);
    expect(calls).toHaveLength(0);
  });
});
