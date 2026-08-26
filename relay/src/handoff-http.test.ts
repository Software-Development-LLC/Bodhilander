/**
 * The handoff drop box: who may fill a slot, who may read it, that one account
 * holds one bundle, that an acknowledgement drops only the bundle it names —
 * and that nothing this database holds opens the bytes in it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createDecipheriv, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { openDb, type RelayDb } from './db';
import { createRepositories, type Repositories, type User } from './repositories';
import { createRouter } from './http';
import { purgeExpiredHandoffs } from './handoff-store';
import { toArrayBuffer } from './crypto';
// The desktop's sealing, used verbatim: a stand-in would prove the sweep below
// against bytes the relay never actually stores.
import { sealHandoff } from '../../src/main/transfer/handoff-crypto';
import { deriveHandoffKey } from '../../src/main/transfer/recovery-phrase';

const logger = createLogger('error');
const env = { NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test', HANDOFF_MAX_BYTES: '4096' };

const OLD_IP = '203.0.113.7';
const NEW_IP = '203.0.113.8';

interface TestMachine {
  id: string;
  sign: (m: Uint8Array) => Promise<Uint8Array>;
}

interface Fixture {
  db: RelayDb;
  /** Where sealed bundles land, so a test can look at what is really on disk. */
  dir: string;
  repos: Repositories;
  route: ReturnType<typeof createRouter>;
  user: User;
  oldMachine: TestMachine;
  newMachine: TestMachine;
  stranger: TestMachine;
  advance: (ms: number) => void;
}

async function machine(repos: Repositories, userId: string, name: string): Promise<TestMachine> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const code = repos.createLinkCode(name, pub, new Uint8Array(32).fill(1), 600).code;
  const claim = repos.claimLinkCode(code, userId);
  if (!claim.ok) throw new Error('fixture could not link a machine');
  return {
    id: claim.machine.id,
    sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, toArrayBuffer(m))),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function fixture(overrides: Record<string, string> = {}): Promise<Fixture> {
  const db = openDb(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-handoff-'));
  dirs.push(dir);
  let offset = 0;
  const repos = createRepositories(db, () => Date.now() + offset);
  const { config } = loadConfig({ ...env, HANDOFF_DIR: dir, ...overrides });
  const route = createRouter({ config, logger, repos });

  const user = repos.upsertGithubUser({
    providerUserId: '1',
    displayName: 'Will',
    login: 'will-l',
    email: null,
    avatarUrl: null,
  });
  const other = repos.upsertGithubUser({
    providerUserId: '2',
    displayName: 'Dana',
    login: 'dana-k',
    email: null,
    avatarUrl: null,
  });

  return {
    db,
    dir,
    repos,
    route,
    user,
    oldMachine: await machine(repos, user.id, 'Old Laptop'),
    newMachine: await machine(repos, user.id, 'New Laptop'),
    stranger: await machine(repos, other.id, "Dana's Desktop"),
    advance: (ms) => {
      offset += ms;
    },
  };
}

async function signed(m: TestMachine, parts: string[], extra: Record<string, string> = {}) {
  const issuedAt = Date.now();
  const message = new TextEncoder().encode([...parts, String(issuedAt)].join('\n'));
  return {
    'x-bodhi-issued-at': String(issuedAt),
    'x-bodhi-signature': Buffer.from(await m.sign(message)).toString('base64'),
    ...extra,
  };
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function put(f: Fixture, m: TestMachine, sealed: Buffer, opts: { digest?: string; ip?: string } = {}) {
  const digest = opts.digest ?? sha256Hex(sealed);
  return f.route(
    new Request(`http://relay.test/api/machines/${m.id}/handoff`, {
      method: 'PUT',
      headers: await signed(m, ['handoff-put:v1', m.id, digest], { 'x-bodhi-content-sha256': digest }),
      body: new Uint8Array(sealed),
    }),
    opts.ip ?? OLD_IP,
  );
}

async function meta(f: Fixture, m: TestMachine) {
  return f.route(
    new Request(`http://relay.test/api/machines/${m.id}/handoff`, {
      headers: await signed(m, ['handoff-meta:v1', m.id]),
    }),
    NEW_IP,
  );
}

async function fetchBundle(f: Fixture, m: TestMachine) {
  return f.route(
    new Request(`http://relay.test/api/machines/${m.id}/handoff/bundle`, {
      headers: await signed(m, ['handoff-get:v1', m.id]),
    }),
    NEW_IP,
  );
}

async function acknowledge(f: Fixture, m: TestMachine, handoffId: string) {
  return f.route(
    new Request(`http://relay.test/api/machines/${m.id}/handoff?id=${handoffId}`, {
      method: 'DELETE',
      headers: await signed(m, ['handoff-delete:v1', m.id, handoffId]),
    }),
    NEW_IP,
  );
}

describe('preparing a handoff', () => {
  test('a linked machine may fill its account slot, and the other machine is told whose it is', async () => {
    const f = await fixture();
    const { bytes } = sealHandoff(Buffer.from('a whole machine'));

    const put1 = await put(f, f.oldMachine, bytes);
    expect(put1.status).toBe(200);

    const offer = (await (await meta(f, f.newMachine)).json()) as { handoff: Record<string, unknown> };
    expect(offer.handoff.sourceMachineId).toBe(f.oldMachine.id);
    expect(offer.handoff.sourceMachineName).toBe('Old Laptop');
    expect(offer.handoff.byteSize).toBe(bytes.length);
    // The one thing the metadata must never carry.
    expect(JSON.stringify(offer)).not.toContain('ciphertext');
  });

  test('another account sees nothing at all', async () => {
    const f = await fixture();
    await put(f, f.oldMachine, sealHandoff(Buffer.from('mine')).bytes);
    expect(await (await meta(f, f.stranger)).json()).toEqual({ handoff: null });
    expect((await fetchBundle(f, f.stranger)).status).toBe(404);
  });

  test('an unsigned or wrongly signed upload is refused', async () => {
    const f = await fixture();
    const { bytes } = sealHandoff(Buffer.from('a whole machine'));
    const digest = sha256Hex(bytes);

    const bare = await f.route(
      new Request(`http://relay.test/api/machines/${f.oldMachine.id}/handoff`, {
        method: 'PUT',
        headers: { 'x-bodhi-content-sha256': digest },
        body: new Uint8Array(bytes),
      }),
      OLD_IP,
    );
    expect(bare.status).toBe(400);

    // A signature from a machine that is not the one named in the path.
    const impostor = await f.route(
      new Request(`http://relay.test/api/machines/${f.oldMachine.id}/handoff`, {
        method: 'PUT',
        headers: await signed(f.stranger, ['handoff-put:v1', f.oldMachine.id, digest], {
          'x-bodhi-content-sha256': digest,
        }),
        body: new Uint8Array(bytes),
      }),
      OLD_IP,
    );
    expect(impostor.status).toBe(401);
    expect(await (await meta(f, f.newMachine)).json()).toEqual({ handoff: null });
  });

  test('a body that is not what was signed for is refused', async () => {
    const f = await fixture();
    const { bytes } = sealHandoff(Buffer.from('a whole machine'));
    const swapped = await put(f, f.oldMachine, bytes, { digest: sha256Hex(Buffer.from('something else')) });
    expect(swapped.status).toBe(400);
    expect(await swapped.json()).toEqual({ error: 'digest_mismatch' });
  });

  test('is capped, and the cap is enforced on the bytes rather than the claim', async () => {
    const f = await fixture();
    const oversized = Buffer.alloc(5000, 7);
    const refused = await put(f, f.oldMachine, oversized);
    expect(refused.status).toBe(413);
    expect(await (await meta(f, f.newMachine)).json()).toEqual({ handoff: null });
  });

  test('replaces the account slot rather than accumulating in it', async () => {
    const f = await fixture();
    await put(f, f.oldMachine, sealHandoff(Buffer.from('first')).bytes);
    const first = (await (await meta(f, f.newMachine)).json()) as { handoff: { id: string } };

    await put(f, f.oldMachine, sealHandoff(Buffer.from('second')).bytes);
    const second = (await (await meta(f, f.newMachine)).json()) as { handoff: { id: string } };

    expect(second.handoff.id).not.toBe(first.handoff.id);
    expect(f.db.query('SELECT COUNT(*) AS n FROM handoff_bundles').get()).toEqual({ n: 1 });
  });
});

describe('restoring and acknowledging', () => {
  test('the bytes come back exactly, and the id says which bundle they are', async () => {
    const f = await fixture();
    const { bytes } = sealHandoff(Buffer.from('a whole machine'));
    await put(f, f.oldMachine, bytes);

    const res = await fetchBundle(f, f.newMachine);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);

    const id = res.headers.get('x-bodhi-handoff-id')!;
    expect((await acknowledge(f, f.newMachine, id)).status).toBe(204);
    expect(await (await meta(f, f.newMachine)).json()).toEqual({ handoff: null });
  });

  test('an acknowledgement cannot drop a bundle it did not name', async () => {
    const f = await fixture();
    await put(f, f.oldMachine, sealHandoff(Buffer.from('first')).bytes);
    const stale = ((await (await meta(f, f.newMachine)).json()) as { handoff: { id: string } }).handoff.id;

    // The source machine prepares a fresh one while the destination is busy.
    await put(f, f.oldMachine, sealHandoff(Buffer.from('second')).bytes);

    expect((await acknowledge(f, f.newMachine, stale)).status).toBe(404);
    const still = (await (await meta(f, f.newMachine)).json()) as { handoff: { id: string } | null };
    expect(still.handoff).not.toBeNull();
    expect(still.handoff!.id).not.toBe(stale);
  });

  test('an id that could forge the signed lines is refused before anything else', async () => {
    const f = await fixture();
    await put(f, f.oldMachine, sealHandoff(Buffer.from('first')).bytes);
    const res = await f.route(
      new Request(`http://relay.test/api/machines/${f.newMachine.id}/handoff?id=${encodeURIComponent('a\nb')}`, {
        method: 'DELETE',
        headers: await signed(f.newMachine, ['handoff-delete:v1', f.newMachine.id, 'a\nb']),
      }),
      NEW_IP,
    );
    expect(res.status).toBe(400);
  });

  test('stops being offered once its time is up', async () => {
    const f = await fixture({ HANDOFF_TTL_SECONDS: '60' });
    await put(f, f.oldMachine, sealHandoff(Buffer.from('a whole machine')).bytes);
    expect(((await (await meta(f, f.newMachine)).json()) as { handoff: unknown }).handoff).not.toBeNull();

    f.advance(61_000);
    expect(await (await meta(f, f.newMachine)).json()).toEqual({ handoff: null });
    expect((await fetchBundle(f, f.newMachine)).status).toBe(404);
    expect(f.repos.purgeExpiredHandoffBundles()).toHaveLength(1);
    expect(f.db.query('SELECT COUNT(*) AS n FROM handoff_bundles').get()).toEqual({ n: 0 });
  });
});

describe('rate limits', () => {
  test('one address cannot upload without bound', async () => {
    const f = await fixture();
    const sealed = sealHandoff(Buffer.from('a whole machine')).bytes;
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await put(f, f.oldMachine, sealed)).status);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  test('nor can one machine, however many addresses it comes from', async () => {
    const f = await fixture();
    const sealed = sealHandoff(Buffer.from('a whole machine')).bytes;
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await put(f, f.oldMachine, sealed, { ip: `198.51.100.${i}` })).status);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  test('reading is bounded too', async () => {
    const f = await fixture();
    await put(f, f.oldMachine, sealHandoff(Buffer.from('a whole machine')).bytes);
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await meta(f, f.newMachine)).status;
    expect(last).toBe(429);
  });
});

/**
 * The tables a linked machine with a prepared handoff fills. Named so the
 * sweep below cannot quietly narrow to a database that holds almost nothing.
 */
const POPULATED_BY_A_HANDOFF = ['handoff_bundles', 'link_codes', 'machines', 'oauth_identities', 'users'];

/**
 * Try `key` against a stored handoff the way its own opener would. The header
 * is `BDHLHOFF` plus a version byte; the nonce is the fixed counter zero.
 */
function opens(stored: Buffer, key: Buffer): boolean {
  if (key.length !== 32) return false;
  try {
    const body = stored.subarray(9);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.alloc(12));
    decipher.setAuthTag(body.subarray(body.length - 16));
    Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}

describe('the disk the store sits on', () => {
  test('a bundle is one file, and replacing one leaves exactly one behind', async () => {
    const f = await fixture();
    await put(f, f.oldMachine, sealHandoff(Buffer.from('first')).bytes);
    expect(fs.readdirSync(f.dir)).toHaveLength(1);
    const first = fs.readdirSync(f.dir)[0]!;

    await put(f, f.oldMachine, sealHandoff(Buffer.from('second')).bytes);
    const after = fs.readdirSync(f.dir);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(first);
  });

  test('acknowledging a restore takes the file with the row', async () => {
    const f = await fixture();
    await put(f, f.oldMachine, sealHandoff(Buffer.from('a whole machine')).bytes);
    const id = (await fetchBundle(f, f.newMachine)).headers.get('x-bodhi-handoff-id')!;

    expect((await acknowledge(f, f.newMachine, id)).status).toBe(204);
    expect(fs.readdirSync(f.dir)).toEqual([]);
  });

  test('expiry takes the file too, not just the row', async () => {
    const f = await fixture({ HANDOFF_TTL_SECONDS: '60' });
    await put(f, f.oldMachine, sealHandoff(Buffer.from('a whole machine')).bytes);
    expect(fs.readdirSync(f.dir)).toHaveLength(1);

    f.advance(61_000);
    expect(await purgeExpiredHandoffs(f.repos, f.dir)).toBe(1);
    expect(fs.readdirSync(f.dir)).toEqual([]);
  });

  test('refuses an upload the store as a whole has no room for', async () => {
    const f = await fixture({ HANDOFF_STORE_MAX_BYTES: '200' });
    expect((await put(f, f.stranger, sealHandoff(Buffer.alloc(120)).bytes, { ip: '198.51.100.9' })).status).toBe(200);

    const refused = await put(f, f.oldMachine, sealHandoff(Buffer.alloc(120)).bytes);
    expect(refused.status).toBe(507);
    expect(await refused.json()).toEqual({ error: 'store_full' });
    // Nothing half-written left over.
    expect(fs.readdirSync(f.dir)).toHaveLength(1);
  });

  test('does not count a user against themselves when they replace their own', async () => {
    const f = await fixture({ HANDOFF_STORE_MAX_BYTES: '200' });
    expect((await put(f, f.oldMachine, sealHandoff(Buffer.alloc(120)).bytes)).status).toBe(200);
    expect((await put(f, f.oldMachine, sealHandoff(Buffer.alloc(120)).bytes)).status).toBe(200);
    expect(fs.readdirSync(f.dir)).toHaveLength(1);
  });

  test('a body that does not match its digest leaves no file', async () => {
    const f = await fixture();
    const res = await put(f, f.oldMachine, sealHandoff(Buffer.from('x')).bytes, {
      digest: sha256Hex(Buffer.from('something else')),
    });
    expect(res.status).toBe(400);
    expect(fs.readdirSync(f.dir)).toEqual([]);
  });
});

describe('what the relay can do with what it stores', () => {
  test('no value it has stored opens the bundle, and the phrase does', async () => {
    const f = await fixture();
    const { bytes, phrase } = sealHandoff(Buffer.from('the whole machine, in the clear'));
    await put(f, f.oldMachine, bytes);

    const { id } = (f.db.query('SELECT id FROM handoff_bundles').get() as { id: string });
    const stored = fs.readFileSync(path.join(f.dir, `${id}.bundle`));
    expect(stored.equals(bytes)).toBe(true);

    // Every value the relay actually holds, raw and hashed to key length:
    // public keys, ids, names, timestamps, token hashes. An empty table
    // contributes nothing, so which ones were populated is asserted below.
    const tables = f.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];

    const material: Buffer[] = [];
    const populated: string[] = [];
    for (const { name } of tables) {
      const rows = f.db.query(`SELECT * FROM ${name}`).all() as Record<string, unknown>[];
      if (rows.length > 0) populated.push(name);
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (value === null || value === undefined) continue;
          const raw = Buffer.isBuffer(value)
            ? value
            : value instanceof Uint8Array
              ? Buffer.from(value)
              : Buffer.from(String(value), 'utf8');
          material.push(raw, createHash('sha256').update(raw).digest());
        }
      }
    }

    expect(populated.sort()).toEqual(POPULATED_BY_A_HANDOFF);
    expect(material.length).toBeGreaterThan(100);
    expect(material.filter((key) => opens(stored, key))).toEqual([]);
    // The positive control: the sweep above WOULD have found a working key.
    expect(opens(stored, deriveHandoffKey(phrase))).toBe(true);
  });
});
