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
    expect(t.sock().types()).toEqual(['auth', 'heartbeat']);
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
    expect(t.sock().types()).toEqual(['auth', 'reply', 'heartbeat']);
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
