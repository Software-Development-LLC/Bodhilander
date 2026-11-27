import { describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { HubClient, resolveHubUrl, HUB_URL_DEVELOPMENT, HUB_URL_PRODUCTION } = await import('../hub-client');
import type { HubSocket } from '../hub-client';
import { HEARTBEAT_MS, LEASE_MS } from '../protocol';
import { HIRE, MACHINE, PERSON, crewDb, uuid } from './crew-db';

class FakeSocket {
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  private handlers: Record<string, ((arg: unknown) => void)[]> = {};
  on(event: string, cb: (arg: unknown) => void) {
    (this.handlers[event] ??= []).push(cb);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
  }
  terminated = false;
  terminate() {
    this.terminated = true;
  }
  hub(frame: Record<string, unknown>) {
    for (const cb of this.handlers.message ?? []) cb(JSON.stringify(frame));
  }
  drop(code: number) {
    for (const cb of this.handlers.close ?? []) cb(code);
  }
  types() {
    return this.sent.map((f) => f.type);
  }
}

function setup(opts: { machineId?: string | null; signThrows?: boolean } = {}) {
  const { raw, db } = crewDb();
  const c = { m: 0, w: 1_700_000_000_000 };
  const timeouts: { fn: () => void; ms: number }[] = [];
  const intervals: { fn: () => void; ms: number; live: boolean }[] = [];
  let machineId: string | null = opts.machineId === undefined ? MACHINE : opts.machineId;
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const signed: string[] = [];
  const interrupted: string[] = [];
  const client = new HubClient({
    db,
    hubUrl: 'https://crew.bodhi.software',
    getMachineId: () => machineId,
    forgetMachineId: () => {
      machineId = null;
    },
    sign: (msg) => {
      if (opts.signThrows) throw new Error('keychain locked');
      signed.push(new TextDecoder().decode(msg));
      return Buffer.from('sig');
    },
    connect: (url) => {
      urls.push(url);
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as HubSocket;
    },
    interruptRun: (hireId) => interrupted.push(hireId),
    clocks: { mono: () => c.m, wall: () => c.w },
    timers: {
      setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
      clearTimeout: () => {},
      setInterval: (fn, ms) => {
        const t = { fn, ms, live: true };
        intervals.push(t);
        return t;
      },
      clearInterval: (h) => {
        if (h) (h as { live: boolean }).live = false;
      },
    },
    random: () => 0,
  });
  const statuses: string[] = [];
  client.on('status', (s) => statuses.push(s));
  const sock = () => sockets[sockets.length - 1];
  const online = () => {
    client.start();
    sock().hub({ type: 'challenge', version: 2, nonce: 'n1', hubTime: c.w });
    sock().hub({ type: 'welcome', machineId: MACHINE, hubTime: c.w, ownerName: 'Ann', ownerUpn: 'ann@x' });
  };
  const advance = (ms: number) => {
    c.m += ms;
    c.w += ms;
  };
  return { raw, db, c, client, sockets, sock, urls, signed, interrupted, statuses, timeouts, intervals, online, advance };
}

const renewFor = (seq: number, epoch = 1) => ({ type: 'renew', seq, hubTime: 0, leases: [{ hireId: HIRE, epoch }] });
const deliver = (n: number, epoch = 1) => ({
  type: 'deliver', id: uuid(n), hireId: HIRE, epoch, scope: 'owner', requestedBy: PERSON, text: 'hi', from: 'B',
});

describe('resolveHubUrl', () => {
  test('packaged builds use production, unpackaged development, and the preference wins', () => {
    expect(resolveHubUrl(true, null)).toBe(HUB_URL_PRODUCTION);
    expect(resolveHubUrl(false, null)).toBe(HUB_URL_DEVELOPMENT);
    expect(resolveHubUrl(true, ' https://h.example// ')).toBe('https://h.example');
    expect(resolveHubUrl(false, '')).toBe(HUB_URL_DEVELOPMENT);
    expect(resolveHubUrl(false, 'http://localhost:8080/')).toBe('http://localhost:8080');
    expect(resolveHubUrl(false, 'http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(resolveHubUrl(false, 'http://[::1]:8080')).toBe('http://[::1]:8080');
  });

  test('a plain http override off this machine is ignored', () => {
    expect(resolveHubUrl(true, 'http://h.example')).toBe(HUB_URL_PRODUCTION);
    expect(resolveHubUrl(false, 'http://10.0.0.5:8080')).toBe(HUB_URL_DEVELOPMENT);
    expect(resolveHubUrl(true, 'ftp://localhost')).toBe(HUB_URL_PRODUCTION);
    expect(resolveHubUrl(true, 'not a url')).toBe(HUB_URL_PRODUCTION);
  });

  test('an https override that does not parse, or names no host, is ignored', () => {
    expect(resolveHubUrl(true, 'https://')).toBe(HUB_URL_PRODUCTION);
    expect(resolveHubUrl(true, 'https://bad host')).toBe(HUB_URL_PRODUCTION);
    expect(resolveHubUrl(true, 'https://h.example/crew/')).toBe('https://h.example/crew');
  });
});

describe('HubClient handshake', () => {
  test('a machine that never linked opens nothing', () => {
    const t = setup({ machineId: null });
    t.client.start();
    expect(t.sockets).toEqual([]);
    expect(t.client.getStatus()).toBe('idle');
    expect(t.intervals).toEqual([]);
  });

  test('signs exactly the auth message over the challenge nonce, then waits for welcome', () => {
    const t = setup();
    t.client.start();
    expect(t.urls).toEqual(['wss://crew.bodhi.software/ws']);
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n1', hubTime: t.c.w + 5000 });
    expect(t.signed).toEqual([`bodhi-crew-hub-auth-v1:crew.bodhi.software:${MACHINE}:n1`]);
    expect(t.sock().sent).toEqual([{ type: 'auth', version: 2, machineId: MACHINE, sig: Buffer.from('sig').toString('base64') }]);
    expect(t.client.clockSkewMs()).toBe(5000);
    t.sock().hub({ type: 'welcome', machineId: MACHINE, hubTime: t.c.w, ownerName: 'Ann', ownerUpn: 'ann@x' });
    expect(t.client.getStatus()).toBe('online');
    expect(t.client.owner()).toEqual({ name: 'Ann', upn: 'ann@x' });
    expect(t.sock().types()).toEqual(['auth', 'sync_pull', 'heartbeat']);
  });

  test('a challenge at another version stops with update-required and never signs', () => {
    const t = setup();
    t.client.start();
    t.sock().hub({ type: 'challenge', version: 3, nonce: 'n1', hubTime: 1 });
    expect(t.signed).toEqual([]);
    expect(t.client.getStatus()).toBe('update-required');
    t.sock().drop(1000);
    expect(t.timeouts).toEqual([]);
  });

  test('a key that cannot sign stops with key-unavailable', () => {
    const t = setup({ signThrows: true });
    t.client.start();
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n1', hubTime: 1 });
    expect(t.client.getStatus()).toBe('key-unavailable');
    expect(t.sock().sent).toEqual([]);
  });

  test('a welcome for another machine stops with link-again', () => {
    const t = setup();
    t.client.start();
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n1', hubTime: 1 });
    t.sock().hub({ type: 'welcome', machineId: uuid(9), hubTime: 1, ownerName: 'A', ownerUpn: 'a' });
    expect(t.client.getStatus()).toBe('link-again');
  });

  test('any frame other than challenge first closes the socket', () => {
    const t = setup();
    t.client.start();
    t.sock().hub(deliver(1));
    expect(t.sock().closed).toBe(1000);
  });

  test('a clock more than two minutes off holds routines', () => {
    const t = setup();
    t.client.start();
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n1', hubTime: t.c.w + 120_001 });
    expect(t.client.routinesHeldForSkew()).toBe(true);
    t.sock().hub({ type: 'welcome', machineId: MACHINE, hubTime: t.c.w + 120_000, ownerName: 'A', ownerUpn: 'a' });
    expect(t.client.routinesHeldForSkew()).toBe(false);
  });
});

describe('HubClient close handling', () => {
  const cases: [number, string, boolean][] = [
    [4426, 'update-required', false],
    [4401, 'link-again', false],
    [4409, 'replaced', false],
    [4403, 'pending', true],
    [4408, 'unavailable', true],
    [1011, 'unavailable', true],
    [1008, 'unavailable', true],
    [1006, 'unavailable', true],
  ];
  for (const [code, status, reconnects] of cases) {
    test(`close ${code} means ${status}`, () => {
      const t = setup();
      t.client.start();
      t.sock().drop(code);
      expect(t.client.getStatus()).toBe(status);
      expect(t.timeouts.length).toBe(reconnects ? 1 : 0);
    });
  }

  test('the error frame reason wins over the close code', () => {
    const t = setup();
    t.client.start();
    t.sock().hub({ type: 'error', reason: 'bad-auth' });
    t.sock().drop(4409);
    expect(t.client.getStatus()).toBe('link-again');
  });

  test('backoff doubles from 1 s to 30 s and a welcome resets it', () => {
    const t = setup();
    t.client.start();
    for (let i = 0; i < 7; i += 1) {
      t.sock().drop(1006);
      t.timeouts[t.timeouts.length - 1].fn();
    }
    expect(t.timeouts.map((x) => x.ms)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n', hubTime: 1 });
    t.sock().hub({ type: 'welcome', machineId: MACHINE, hubTime: 1, ownerName: 'A', ownerUpn: 'a' });
    t.sock().drop(1006);
    expect(t.timeouts[t.timeouts.length - 1].ms).toBe(1000);
  });

  test('jitter takes up to 20% off the backoff', () => {
    const t = setup();
    expect(t.client.backoffMs(0)).toBe(1000);
    const jittered = new HubClient({ ...({} as never), db: t.db, hubUrl: 'https://h.x', getMachineId: () => null, forgetMachineId: () => {}, sign: () => Buffer.alloc(0), connect: () => ({}) as HubSocket, interruptRun: () => {}, random: () => 1 });
    expect(jittered.backoffMs(0)).toBe(800);
    expect(jittered.backoffMs(10)).toBe(24000);
  });

  test('unlinked stops every job, clears the caches, forgets the machine and stops', () => {
    const t = setup();
    t.online();
    t.sock().hub(deliver(1));
    t.raw.exec(`INSERT INTO crew_role_cache (role_id, rev, data) VALUES ('r', 1, '{}')`);
    t.client.sendReply(uuid(1), 'pending reply');
    t.sock().drop(4410);
    expect(t.client.getStatus()).toBe('unlinked');
    expect(t.interrupted).toEqual([HIRE]);
    expect((t.raw.query(`SELECT state FROM crew_job`).get() as { state: string }).state).toBe('dropped');
    expect((t.raw.query(`SELECT state FROM crew_outbox_local`).get() as { state: string }).state).toBe('unsendable');
    expect((t.raw.query(`SELECT COUNT(*) AS n FROM crew_role_cache`).get() as { n: number }).n).toBe(0);
    expect((t.raw.query(`SELECT COUNT(*) AS n FROM crew_hire_cache`).get() as { n: number }).n).toBe(0);
    t.client.start();
    expect(t.sockets.length).toBe(1);
    expect(t.timeouts).toEqual([]);
  });
});

describe('HubClient after welcome', () => {
  test('a delivery is stored and acked; a duplicate is acked again and not re-run', () => {
    const t = setup();
    const jobs: unknown[] = [];
    t.client.on('job', (j) => jobs.push(j));
    t.online();
    t.sock().hub(deliver(1));
    t.sock().hub(deliver(1));
    expect(t.sock().sent.filter((f) => f.type === 'ack')).toEqual([{ type: 'ack', id: uuid(1) }, { type: 'ack', id: uuid(1) }]);
    expect(jobs).toEqual([{ id: uuid(1), hireId: HIRE, outcome: 'stored' }]);
  });

  test('a renew for the heartbeat holds the lease; nothing starts without it', () => {
    const t = setup();
    t.online();
    expect(t.client.canStart(HIRE, 1)).toBe(false);
    t.sock().hub(renewFor(1));
    expect(t.client.canStart(HIRE, 1)).toBe(true);
    expect(t.client.canStart(HIRE, 2)).toBe(false);
    t.advance(LEASE_MS);
    expect(t.client.canStart(HIRE, 1)).toBe(false);
  });

  test('heartbeats repeat every 30 s', () => {
    const t = setup();
    t.online();
    const hb = t.intervals.find((i) => i.ms === HEARTBEAT_MS)!;
    hb.fn();
    expect(t.sock().sent.filter((f) => f.type === 'heartbeat').map((f) => f.seq)).toEqual([1, 2]);
  });

  test('a renew at a newer epoch fences older jobs', () => {
    const t = setup();
    const epochs: unknown[] = [];
    t.client.on('epoch', (e) => epochs.push(e));
    t.online();
    t.sock().hub(deliver(1, 1));
    t.sock().hub(renewFor(1, 2));
    expect(epochs).toEqual([{ hireId: HIRE, epoch: 2 }]);
    expect(t.interrupted).toEqual([HIRE]);
    expect((t.raw.query(`SELECT state FROM crew_job`).get() as { state: string }).state).toBe('dropped');
    expect(t.client.sendReply(uuid(1), 'late')).toBe(false);
  });

  test('a delivery at a newer epoch interrupts the older run; one at the same epoch does not', () => {
    const t = setup();
    t.online();
    t.sock().hub(deliver(1, 1));
    t.sock().hub(deliver(2, 1));
    expect(t.interrupted).toEqual([]);
    t.sock().hub(deliver(3, 2));
    expect(t.interrupted).toEqual([HIRE]);
  });

  test('stop forgets the connection, so a later renew for its heartbeat renews nothing', () => {
    const t = setup();
    t.online();
    t.client.stop();
    expect(t.client.lease.onRenew(1, [{ hireId: HIRE, epoch: 1 }])).toEqual([]);
  });

  test('a reply is cut, stamped with its job epoch, sent and cleared by its ack', () => {
    const t = setup();
    t.online();
    t.sock().hub(deliver(1, 3));
    expect(t.client.sendReply(uuid(1), 'x'.repeat(30_000))).toBe(true);
    const reply = t.sock().sent.find((f) => f.type === 'reply') as { epoch: number; text: string; id: string; hireId: string };
    expect(reply.epoch).toBe(3);
    expect(reply.hireId).toBe(HIRE);
    expect(reply.text.length).toBeLessThanOrEqual(28_000);
    t.sock().hub({ type: 'ack', id: uuid(1) });
    expect((t.raw.query(`SELECT COUNT(*) AS n FROM crew_outbox_local`).get() as { n: number }).n).toBe(0);
  });

  test('every welcome re-sends what was not answered', () => {
    const t = setup();
    t.online();
    t.sock().hub(deliver(1));
    t.client.sendReply(uuid(1), 'r');
    t.sock().drop(1006);
    t.timeouts[0].fn();
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n2', hubTime: 1 });
    t.sock().hub({ type: 'welcome', machineId: MACHINE, hubTime: 1, ownerName: 'A', ownerUpn: 'a' });
    expect(t.sock().types()).toEqual(['auth', 'reply', 'sync_pull', 'heartbeat']);
  });

  test('stale-epoch and not-home pull sync once per connection', () => {
    const t = setup();
    let pulls = 0;
    t.client.on('sync-needed', () => (pulls += 1));
    t.online();
    for (const n of [1, 2]) {
      t.sock().hub(deliver(n));
      t.client.sendReply(uuid(n), 'r');
    }
    t.sock().hub({ type: 'refused', id: uuid(1), reason: 'stale-epoch' });
    t.sock().hub({ type: 'refused', id: uuid(2), reason: 'not-home' });
    expect(pulls).toBe(1);
  });

  test('lease_revoke drop interrupts, drops every job and answers once with the job epoch', () => {
    const t = setup();
    const revoked: unknown[] = [];
    t.client.on('revoked', (r) => revoked.push(r));
    t.online();
    t.sock().hub(renewFor(1, 4));
    t.sock().hub(deliver(1, 4));
    t.sock().hub({ type: 'lease_revoke', hireId: HIRE, mode: 'drop' });
    expect(t.interrupted).toEqual([HIRE]);
    expect(t.client.canStart(HIRE, 4)).toBe(false);
    expect((t.raw.query(`SELECT state FROM crew_job`).get() as { state: string }).state).toBe('dropped');
    expect(t.sock().sent.filter((f) => f.type === 'lease_revoked')).toEqual([{ type: 'lease_revoked', hireId: HIRE, epoch: 4 }]);
    expect(revoked).toEqual([{ hireId: HIRE, mode: 'drop' }]);
  });

  test('lease_revoke pause, or an unknown mode, keeps the queue', () => {
    for (const mode of ['pause', 'later']) {
      const t = setup();
      t.online();
      t.sock().hub(deliver(1));
      t.raw.exec(`UPDATE crew_job SET state = 'running'`);
      t.sock().hub({ type: 'lease_revoke', hireId: HIRE, mode });
      expect((t.raw.query(`SELECT state FROM crew_job`).get() as { state: string }).state).toBe('queued');
      const audited = (t.raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'lease-revoke-unknown-mode'`).get() as { n: number }).n;
      expect(audited).toBe(mode === 'pause' ? 0 : 1);
    }
  });

  test('a lapse is swept: the run is interrupted and its job queued again', () => {
    const t = setup();
    const lapsed: string[] = [];
    t.client.on('lapsed', (h) => lapsed.push(h));
    t.online();
    t.sock().hub(renewFor(1));
    t.sock().hub(deliver(1));
    t.raw.exec(`UPDATE crew_job SET state = 'running'`);
    const sweep = t.intervals.find((i) => i.ms === 1000)!;
    sweep.fn();
    t.advance(LEASE_MS);
    sweep.fn();
    expect(lapsed).toEqual([HIRE]);
    expect(t.interrupted).toEqual([HIRE]);
    expect((t.raw.query(`SELECT state FROM crew_job`).get() as { state: string }).state).toBe('queued');
  });

  test('a resume lapses every lease at once', () => {
    const t = setup();
    t.online();
    t.sock().hub(renewFor(1));
    t.intervals.find((i) => i.ms === 1000)!.fn();
    t.client.onResume();
    expect(t.client.canStart(HIRE, 1)).toBe(false);
    expect(t.interrupted).toEqual([HIRE]);
  });

  test('a malformed frame is dropped and audited once per type', () => {
    const t = setup();
    t.online();
    t.sock().hub({ ...deliver(1), scope: 'everyone' });
    t.sock().hub({ ...deliver(2), scope: 'everyone' });
    expect(t.sock().sent.filter((f) => f.type === 'ack')).toEqual([]);
    expect((t.raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'hub-frame-dropped'`).get() as { n: number }).n).toBe(1);
  });
});

describe('HubClient sync', () => {
  const pulls = (t: ReturnType<typeof setup>) => t.sock().sent.filter((f) => f.type === 'sync_pull') as { id: string; since: number }[];
  const role = (seq: number) => ({ kind: 'role', objectId: 'po', rev: seq, seq, hash: 'h', deleted: false, body: { role: 'po' } });

  test('welcome pulls since the stored sequence; a page applies; a change pulls again', () => {
    const t = setup();
    t.raw.exec(`INSERT INTO crew_sync_state (key, value) VALUES ('sync.seq', '12')`);
    const synced: number[] = [];
    t.client.on('synced', (n) => synced.push(n));
    t.online();
    const [first] = pulls(t);
    expect(first.since).toBe(12);
    t.sock().hub({ type: 'sync_page', id: first.id, changes: [role(13)], next: 13, more: false });
    expect(synced).toEqual([1]);
    expect(t.client.sync.since()).toBe(13);
    expect((t.raw.query(`SELECT rev FROM crew_role_cache`).get() as { rev: number }).rev).toBe(13);
    t.sock().hub({ type: 'change', seq: 14 });
    expect(pulls(t).map((p) => p.since)).toEqual([12, 13]);
  });

  test('a page for no pull is ignored', () => {
    const t = setup();
    const synced: number[] = [];
    t.client.on('synced', (n) => synced.push(n));
    t.online();
    t.sock().hub({ type: 'sync_page', id: uuid(77), changes: [role(1)], next: 1, more: false });
    expect(synced).toEqual([]);
    expect(t.client.sync.since()).toBe(0);
  });

  test('an unanswered pull goes again on the heartbeat after 30 s; a reconnect pulls afresh', () => {
    const t = setup();
    t.online();
    const hb = t.intervals.find((i) => i.ms === HEARTBEAT_MS)!;
    hb.fn();
    expect(pulls(t)).toHaveLength(1);
    t.advance(30_000);
    hb.fn();
    expect(pulls(t)).toHaveLength(2);
    expect(pulls(t)[1].id).toBe(pulls(t)[0].id);
    const before = pulls(t)[0].id;
    t.sock().drop(1006);
    t.timeouts[0].fn();
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n2', hubTime: t.c.w });
    t.sock().hub({ type: 'welcome', machineId: MACHINE, hubTime: t.c.w, ownerName: 'A', ownerUpn: 'a' });
    expect(pulls(t)).toHaveLength(1);
    expect(pulls(t)[0].id).not.toBe(before);
  });

  test('a page proves the Hub read past the replies sent before its pull', () => {
    const t = setup();
    t.online();
    t.sock().hub(deliver(1));
    t.client.sendReply(uuid(1), 'r');
    t.sock().drop(1006);
    t.timeouts[0].fn();
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n2', hubTime: t.c.w });
    t.sock().hub({ type: 'welcome', machineId: MACHINE, hubTime: t.c.w, ownerName: 'A', ownerUpn: 'a' });
    t.sock().hub({ type: 'sync_page', id: pulls(t)[0].id, changes: [], next: 0, more: false });
    t.advance(30_000);
    t.intervals.filter((i) => i.ms === HEARTBEAT_MS && i.live).at(-1)!.fn();
    expect((t.raw.query(`SELECT unanswered FROM crew_outbox_local`).get() as { unanswered: number }).unanswered).toBe(1);
  });

  test('a stale-epoch refusal pulls once the pull already out is answered', () => {
    const t = setup();
    t.online();
    t.sock().hub({ type: 'sync_page', id: pulls(t)[0].id, changes: [], next: 0, more: false });
    t.sock().hub(deliver(1));
    t.client.sendReply(uuid(1), 'r');
    t.sock().hub({ type: 'refused', id: uuid(1), reason: 'stale-epoch' });
    expect(pulls(t)).toHaveLength(2);
  });
});

describe('HubClient queued frames', () => {
  const sentOf = (t: ReturnType<typeof setup>, type: string) => t.sock().sent.filter((f) => f.type === type) as Record<string, unknown>[];

  test('an edit carries the cached rev and the hire epoch; its edit_result clears it', () => {
    const t = setup();
    const results: unknown[] = [];
    t.client.on('edit-result', (r) => results.push(r));
    t.online();
    t.sock().hub(deliver(1, 5));
    t.client.sync.apply({ kind: 'hire', objectId: HIRE, rev: 3, seq: 1, hash: 'h', deleted: false, body: {} });
    const id = t.client.sendEdit({ op: 'update', kind: 'hire', objectId: HIRE, hireId: HIRE, fields: { name: 'PO' } });
    expect(sentOf(t, 'edit')).toEqual([{ type: 'edit', id, op: 'update', kind: 'hire', objectId: HIRE, rev: 3, hireId: HIRE, epoch: 5, fields: { name: 'PO' } }]);
    t.sock().hub({ type: 'edit_result', id, result: 'applied', objectId: HIRE, rev: 4 });
    expect((t.raw.query(`SELECT COUNT(*) AS n FROM crew_outbox_local`).get() as { n: number }).n).toBe(0);
    expect(results).toEqual([{ type: 'edit_result', id, result: 'applied', objectId: HIRE, rev: 4 }]);
  });

  test('a conflicting edit shows the Hub copy', () => {
    const t = setup();
    t.online();
    t.client.sync.apply({ kind: 'routine', objectId: 'r1', rev: 1, seq: 1, hash: 'h', deleted: false, body: { cron: 'mine' } });
    const id = t.client.sendEdit({ op: 'update', kind: 'routine', objectId: 'r1', fields: { cron: 'x' } });
    expect(sentOf(t, 'edit')[0].hireId).toBeUndefined();
    const current = { kind: 'routine', objectId: 'r1', rev: 2, seq: 2, hash: 'h2', deleted: false, body: { cron: 'theirs' } };
    t.sock().hub({ type: 'edit_result', id, result: 'conflict', current });
    expect((t.raw.query(`SELECT data FROM crew_routine_cache`).get() as { data: string }).data).toBe('{"cron":"theirs"}');
  });

  test('an edit made offline waits in the outbox for welcome', () => {
    const t = setup();
    t.client.sendEdit({ op: 'create', kind: 'routine', fields: { cron: 'x' } });
    t.online();
    expect(t.sock().types()).toEqual(['auth', 'edit', 'sync_pull', 'heartbeat']);
  });

  test('usage is stamped with its job epoch; a gone or fenced job sends nothing', () => {
    const t = setup();
    t.online();
    t.sock().hub(deliver(1, 2));
    const usage = {
      runId: uuid(40), requestedBy: PERSON, accountUuid: 'acct', startedAt: 1, durationMs: 2, model: 'm', inputTokens: 3,
      outputTokens: 4, cacheCreationTokens: 5, cacheReadTokens: 6, costEquivalentMicroUsd: 7, windows: [], windowsReadAt: 8,
    };
    expect(t.client.sendUsage(uuid(1), usage)).toBe(true);
    const [sent] = sentOf(t, 'usage_record');
    expect(sent).toEqual({ type: 'usage_record', id: sent.id, hireId: HIRE, epoch: 2, ...usage });
    expect(sent.id).not.toBe(uuid(1));
    expect(t.client.sendUsage(uuid(99), usage)).toBe(false);
    t.sock().hub(deliver(2, 3));
    expect(t.client.sendUsage(uuid(1), usage)).toBe(false);
    expect(sentOf(t, 'usage_record')).toHaveLength(1);
  });

  test('an audit about a hire carries its newest epoch; one about the machine carries neither', () => {
    const t = setup();
    t.online();
    t.sock().hub(deliver(1, 6));
    const a = t.client.sendAudit('hold', { state: 'held:missing' }, HIRE);
    const b = t.client.sendAudit('machine-note', {});
    expect(sentOf(t, 'audit')).toEqual([
      { type: 'audit', id: a, event: 'hold', at: t.c.w, detail: { state: 'held:missing' }, hireId: HIRE, epoch: 6 },
      { type: 'audit', id: b, event: 'machine-note', at: t.c.w, detail: {} },
    ]);
    const rows = t.raw.query(`SELECT hire_id, epoch FROM crew_outbox_local ORDER BY seq`).all();
    expect(rows).toEqual([{ hire_id: HIRE, epoch: 6 }, { hire_id: null, epoch: null }]);
  });
});

describe('HubClient connection health', () => {
  const heartbeats = (t: ReturnType<typeof setup>) => t.sock().sent.filter((f) => f.type === 'heartbeat').length;
  const beat = (t: ReturnType<typeof setup>) => t.intervals.filter((i) => i.ms === HEARTBEAT_MS && i.live).at(-1)!.fn();

  test('three heartbeats with no renew drop the socket and back off', () => {
    const t = setup();
    t.online();
    beat(t);
    beat(t);
    expect(t.sock().terminated).toBe(false);
    beat(t);
    expect(heartbeats(t)).toBe(3);
    expect(t.sock().terminated).toBe(true);
    expect(t.client.getStatus()).toBe('unavailable');
    expect(t.timeouts.map((x) => x.ms)).toEqual([1000]);
    t.sock().drop(1006);
    expect(t.timeouts).toHaveLength(1);
  });

  test('a renew keeps the connection', () => {
    const t = setup();
    t.online();
    for (let seq = 2; seq <= 6; seq += 1) {
      t.sock().hub(renewFor(seq - 1));
      beat(t);
    }
    expect(t.sock().terminated).toBe(false);
    expect(heartbeats(t)).toBe(6);
  });

  test('a resume sends a heartbeat at once, so a renewal can come; offline it sends nothing', () => {
    const t = setup();
    t.online();
    t.client.onResume();
    expect(heartbeats(t)).toBe(2);
    t.sock().hub(renewFor(2));
    expect(t.client.canStart(HIRE, 1)).toBe(true);
    t.sock().drop(1006);
    const sent = t.sock().sent.length;
    t.client.onResume();
    expect(t.sock().sent.length).toBe(sent);
  });

  test('an http Hub override dials ws', () => {
    const t = setup();
    const urls: string[] = [];
    const local = new HubClient({
      db: t.db, hubUrl: 'http://localhost:8080', getMachineId: () => MACHINE, forgetMachineId: () => {}, sign: () => Buffer.alloc(0),
      connect: (url) => {
        urls.push(url);
        return new FakeSocket() as unknown as HubSocket;
      },
      interruptRun: () => {},
      timers: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
    });
    local.start();
    expect(urls).toEqual(['ws://localhost:8080/ws']);
  });

  test('a Hub that is not on loopback is dialled over wss whatever the scheme', () => {
    const urls: string[] = [];
    const remote = new HubClient({
      db: crewDb().db, hubUrl: 'http://h.example', getMachineId: () => MACHINE, forgetMachineId: () => {}, sign: () => Buffer.alloc(0),
      connect: (url) => {
        urls.push(url);
        return new FakeSocket() as unknown as HubSocket;
      },
      interruptRun: () => {},
      timers: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
    });
    remote.start();
    expect(urls).toEqual(['wss://h.example/ws']);
    expect(remote.hubUrl).toBe('http://h.example');
  });

  test('a timer callback that throws is audited, not thrown into the main process', () => {
    const t = setup();
    t.online();
    t.client.outbox.tick = () => {
      throw new Error('disk full');
    };
    t.client.lease.sweep = () => {
      throw new Error('busy');
    };
    for (const i of t.intervals.filter((x) => x.live)) expect(() => i.fn()).not.toThrow();
    const timers = (t.raw.query(`SELECT detail FROM crew_audit WHERE event = 'hub-timer-error'`).all() as { detail: string }[]).map((r) => JSON.parse(r.detail).timer);
    expect(timers.sort()).toEqual(['heartbeat', 'sweep']);
  });

  test('an unlink forgets the bodies still owed', () => {
    const t = setup();
    t.online();
    const pull = t.sock().sent.find((f) => f.type === 'sync_pull') as { id: string };
    t.sock().hub({ type: 'sync_page', id: pull.id, changes: [{ kind: 'note', objectId: 'n1', rev: 1, seq: 2, hash: 'h', deleted: false }], next: 2, more: false });
    expect(t.client.sync.onConnect(0).fetch).toEqual([{ kind: 'note', objectId: 'n1' }]);
    t.sock().drop(4410);
    expect(t.client.sync.onConnect(0)).toEqual(expect.not.objectContaining({ fetch: expect.anything() }));
  });

  test('a Hub under a path prefix is dialled at that prefix', () => {
    const urls: string[] = [];
    const prefixed = new HubClient({
      db: crewDb().db, hubUrl: 'https://h.example/crew', getMachineId: () => MACHINE, forgetMachineId: () => {}, sign: () => Buffer.alloc(0),
      connect: (url) => {
        urls.push(url);
        return new FakeSocket() as unknown as HubSocket;
      },
      interruptRun: () => {},
      timers: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
    });
    prefixed.start();
    expect(urls).toEqual(['wss://h.example/crew/ws']);
  });

  test('a frame dropped, or a handler that throws, with the database gone does not throw', () => {
    const t = setup();
    t.online();
    t.raw.exec('DROP TABLE crew_audit');
    expect(() => t.sock().hub({ type: 'nonsense' })).not.toThrow();
    t.client.sync.onPage = () => {
      throw new Error('disk full');
    };
    const pull = t.sock().sent.find((f) => f.type === 'sync_pull') as { id: string };
    expect(() => t.sock().hub({ type: 'sync_page', id: pull.id, changes: [], next: 0, more: false })).not.toThrow();
  });

  test('a resume that throws is audited, not thrown into the main process', () => {
    const t = setup();
    t.online();
    t.client.lease.onResume = () => {
      throw new Error('busy');
    };
    expect(() => t.client.onResume()).not.toThrow();
    const rows = t.raw.query(`SELECT detail FROM crew_audit WHERE event = 'hub-timer-error'`).all() as { detail: string }[];
    expect(rows.map((r) => JSON.parse(r.detail).timer)).toEqual(['resume']);
  });

  test('a timer error with the database gone still does not throw', () => {
    const t = setup();
    t.online();
    t.client.outbox.tick = () => {
      throw new Error('disk full');
    };
    t.raw.exec('DROP TABLE crew_audit');
    const heartbeat = t.intervals.find((x) => x.live && x.ms === 30_000);
    expect(heartbeat).toBeDefined();
    expect(() => heartbeat!.fn()).not.toThrow();
  });

  test('a reply queued after the socket closed waits for the next welcome', () => {
    const t = setup();
    t.online();
    t.sock().hub(deliver(1));
    t.sock().drop(1006);
    expect(t.client.sendReply(uuid(1), 'r')).toBe(true);
    expect(t.client.outbox.sentIndex(uuid(1))).toBeNull();
  });

  test('a second reply for one job is refused, not thrown', () => {
    const t = setup();
    t.online();
    t.sock().hub(deliver(1));
    expect(t.client.sendReply(uuid(1), 'a')).toBe(true);
    expect(t.client.sendReply(uuid(1), 'b')).toBe(false);
    expect(t.sock().sent.filter((f) => f.type === 'reply')).toHaveLength(1);
  });

  for (const [code, status] of [[4409, 'replaced'], [4410, 'unlinked']] as const) {
    test(`a ${status} close gives up every lease and interrupts its run`, () => {
      const t = setup();
      t.online();
      t.sock().hub(renewFor(1));
      t.sock().hub(deliver(1));
      t.raw.exec(`UPDATE crew_job SET state = 'running'`);
      t.sock().drop(code);
      expect(t.client.canStart(HIRE, 1)).toBe(false);
      expect(t.interrupted[0]).toBe(HIRE);
      const state = (t.raw.query(`SELECT state FROM crew_job`).get() as { state: string }).state;
      expect(state).toBe(status === 'replaced' ? 'queued' : 'dropped');
    });
  }
});

describe('HubClient sync edges', () => {
  test('resumes while offline send nothing, so the next connection is not taken for dead', () => {
    const t = setup();
    t.online();
    t.sock().drop(1006);
    for (let i = 0; i < 3; i += 1) t.client.onResume();
    t.timeouts[0].fn();
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n2', hubTime: t.c.w });
    t.sock().hub({ type: 'welcome', machineId: MACHINE, hubTime: t.c.w, ownerName: 'A', ownerUpn: 'a' });
    expect(t.sock().terminated).toBe(false);
    expect(t.client.getStatus()).toBe('online');
  });

  test('a resume before welcome sends no heartbeat ahead of auth', () => {
    const t = setup();
    t.client.start();
    t.client.onResume();
    t.sock().hub({ type: 'challenge', version: 2, nonce: 'n1', hubTime: t.c.w });
    t.client.onResume();
    expect(t.sock().types()).toEqual(['auth']);
  });

  test('a conflict answered without the current object pulls', () => {
    const t = setup();
    t.online();
    const first = t.sock().sent.find((f) => f.type === 'sync_pull') as { id: string };
    t.sock().hub({ type: 'sync_page', id: first.id, changes: [], next: 0, more: false });
    t.client.sync.apply({ kind: 'routine', objectId: 'r1', rev: 1, seq: 1, hash: 'h', deleted: false, body: {} });
    const id = t.client.sendEdit({ op: 'update', kind: 'routine', objectId: 'r1', fields: {} });
    t.sock().hub({ type: 'edit_result', id, result: 'conflict', objectId: 'r1' });
    expect(t.sock().sent.filter((f) => f.type === 'sync_pull')).toHaveLength(2);
  });
});
