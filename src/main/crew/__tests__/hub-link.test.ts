import { describe, expect, test } from 'bun:test';
import { LinkFlow, buildLinkRequest, requestLinkCode, type LinkDeps } from '../hub-link';
import { MACHINE } from './crew-db';

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

function deps(answers: Answer[], now = 1_700_000_000_000) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const signed: string[] = [];
  let clock = now;
  const d: LinkDeps = {
    hubUrl: 'https://crew.bodhi.software/',
    keys: { ed25519Pub: 'ED', x25519Pub: 'X' },
    name: 'Mac mini',
    sign: (m) => {
      signed.push(new TextDecoder().decode(m));
      return Buffer.from('s');
    },
    now: () => clock++,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const a = answers.shift();
      if (!a) throw new Error('offline');
      return {
        status: a.status,
        headers: { get: (n: string) => a.headers?.[n.toLowerCase()] ?? null },
        json: async () => {
          if (a.body === undefined) throw new Error('no body');
          return a.body;
        },
      };
    },
  };
  return { d, calls, signed };
}

const code = { code: 'abc', confirmCode: 'K7Q2ZP', machineId: MACHINE };

describe('buildLinkRequest', () => {
  test('sends exactly the five published keys and signs the link message', () => {
    const { d, signed } = deps([]);
    const body = buildLinkRequest({ ...d, hubUrl: 'https://crew.bodhi.software' }, 42);
    expect(Object.keys(body).sort()).toEqual(['ed25519Pub', 'issuedAt', 'name', 'sig', 'x25519Pub']);
    expect(signed).toEqual(['bodhi-crew-link-v1\ncrew.bodhi.software\nED\nX\n42\nMac mini']);
    expect(body.sig).toBe(Buffer.from('s').toString('base64'));
  });
});

describe('requestLinkCode', () => {
  test('a code comes back with the link page URL', async () => {
    const { d, calls } = deps([{ status: 200, body: code }]);
    expect(await requestLinkCode(d)).toEqual({ kind: 'code', ...code, linkUrl: 'https://crew.bodhi.software/link?code=abc' });
    expect(calls[0].url).toBe('https://crew.bodhi.software/link/codes');
  });

  test('a malformed answer is refused before anything is stored', async () => {
    for (const body of [
      { ...code, confirmCode: 'K7Q2' },
      { ...code, confirmCode: 'K7-Q2Z' },
      { ...code, machineId: 'nope' },
      { ...code, code: '' },
      undefined,
    ]) {
      const { d } = deps([{ status: 200, body }]);
      expect(await requestLinkCode(d)).toEqual({ kind: 'unreadable' });
    }
  });

  test('clock-skew re-signs once at the Hub time', async () => {
    const { d, calls } = deps([
      { status: 400, body: { error: 'clock-skew', hubTime: 5 } },
      { status: 200, body: code },
    ]);
    expect((await requestLinkCode(d)).kind).toBe('code');
    expect(calls.map((c) => c.body.issuedAt)).toEqual([1_700_000_000_000, 5]);
  });

  test('clock-skew twice stops', async () => {
    const { d, calls } = deps([
      { status: 400, body: { error: 'clock-skew', hubTime: 5 } },
      { status: 400, body: { error: 'clock-skew', hubTime: 6 } },
    ]);
    expect(await requestLinkCode(d)).toEqual({ kind: 'cannot-link', error: 'clock-skew' });
    expect(calls.length).toBe(2);
  });

  test('replayed re-signs once with a fresh issuedAt', async () => {
    const { d, calls } = deps([
      { status: 400, body: { error: 'replayed' } },
      { status: 400, body: { error: 'replayed' } },
    ]);
    expect(await requestLinkCode(d)).toEqual({ kind: 'cannot-link', error: 'replayed' });
    expect(calls.length).toBe(2);
    expect(Number(calls[1].body.issuedAt)).toBeGreaterThan(Number(calls[0].body.issuedAt));
  });

  test('409 already-linked returns the owner', async () => {
    const { d } = deps([{ status: 409, body: { error: 'already-linked', machineId: MACHINE, ownerName: 'Ann', ownerUpn: 'ann@x' } }]);
    expect(await requestLinkCode(d)).toEqual({ kind: 'already-linked', machineId: MACHINE, ownerName: 'Ann', ownerUpn: 'ann@x' });
  });

  test('429 reads Retry-After, and nothing retries', async () => {
    const { d, calls } = deps([{ status: 429, headers: { 'retry-after': '30' } }]);
    expect(await requestLinkCode(d)).toEqual({ kind: 'rate-limited', retryAfterSeconds: 30 });
    expect(calls.length).toBe(1);
    const none = deps([{ status: 429 }]);
    expect(await requestLinkCode(none.d)).toEqual({ kind: 'rate-limited', retryAfterSeconds: null });
  });

  test('other answers', async () => {
    expect(await requestLinkCode(deps([{ status: 400, body: { error: 'bad-signature' } }]).d)).toEqual({ kind: 'cannot-link', error: 'bad-signature' });
    expect(await requestLinkCode(deps([{ status: 502 }]).d)).toEqual({ kind: 'failed', status: 502 });
    expect(await requestLinkCode(deps([]).d)).toEqual({ kind: 'unreachable' });
  });
});

describe('LinkFlow', () => {
  function flow(answers: Answer[]) {
    const { d } = deps(answers);
    const stored: string[] = [];
    const opened: string[] = [];
    let connects = 0;
    const f = new LinkFlow({
      ...d,
      storeMachineId: (m) => stored.push(m),
      openExternal: (u) => opened.push(u),
      connect: () => (connects += 1),
    });
    return { f, stored, opened, connects: () => connects };
  }

  test('a code stores the machine id, opens the page and connects', async () => {
    const t = flow([{ status: 200, body: code }]);
    expect(await t.f.begin()).toEqual({ step: 'show-codes', name: 'Mac mini', confirmCode: 'K7Q2ZP' });
    expect(t.stored).toEqual([MACHINE]);
    expect(t.opened).toEqual(['https://crew.bodhi.software/link?code=abc']);
    expect(t.connects()).toBe(1);
  });

  test('a conflict stores nothing until the person says it is theirs', async () => {
    const conflict = { status: 409, body: { error: 'already-linked', machineId: MACHINE, ownerName: 'Ann', ownerUpn: 'ann@x' } };
    const no = flow([conflict]);
    expect((await no.f.begin()).step).toBe('confirm-owner');
    expect(no.stored).toEqual([]);
    expect(no.f.confirmOwner(false)).toBe(false);
    expect(no.stored).toEqual([]);
    expect(no.connects()).toBe(0);

    const yes = flow([conflict]);
    await yes.f.begin();
    expect(yes.f.confirmOwner(true)).toBe(true);
    expect(yes.stored).toEqual([MACHINE]);
    expect(yes.connects()).toBe(1);
    expect(yes.f.confirmOwner(true)).toBe(false);
  });

  test('a failure stores and opens nothing', async () => {
    const t = flow([{ status: 400, body: { error: 'bad-request' } }]);
    expect((await t.f.begin()).step).toBe('stopped');
    expect(t.stored).toEqual([]);
    expect(t.opened).toEqual([]);
  });
});
