/**
 * The desktop's half of the handoff wire, driven against the relay's own
 * router. Both trees build these signed lines from their own copy of the
 * format, so a divergence is only visible where both are present.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHandoffTransport } from '../handoff-transport';
import { openHandoff, sealHandoff } from '../../../transfer/handoff-crypto';
import { loadConfig } from '../../../../../relay/src/config';
import { createLogger } from '../../../../../relay/src/logger';
import { openDb } from '../../../../../relay/src/db';
import { createRepositories } from '../../../../../relay/src/repositories';
import { createRouter } from '../../../../../relay/src/http';
import { HANDOFF_MAX_BYTES } from '../../../../shared/types';

const logger = createLogger('error');

function identity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    raw: new Uint8Array(Buffer.from(x, 'base64url')),
    sign: (message: Uint8Array) => crypto.sign(null, Buffer.from(message), privateKey),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function relay(env: Record<string, string> = {}) {
  const db = openDb(':memory:');
  const repos = createRepositories(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-handoff-'));
  dirs.push(dir);
  const { config } = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test', HANDOFF_DIR: dir, ...env });
  const route = createRouter({ config, logger, repos });

  const user = repos.upsertGithubUser({
    providerUserId: '1',
    displayName: 'Will',
    login: 'will-l',
    email: null,
    avatarUrl: null,
  });

  function link(name: string) {
    const id = identity();
    const code = repos.createLinkCode(name, id.raw, new Uint8Array(32).fill(1), 600).code;
    const claim = repos.claimLinkCode(code, user.id);
    if (!claim.ok) throw new Error('fixture could not link a machine');
    return createHandoffTransport({
      origin: 'http://relay.test/',
      machineId: claim.machine.id,
      sign: id.sign,
      fetchImpl: (input, init) => route(new Request(input as string, init), '203.0.113.9'),
    });
  }

  return { db, link };
}

describe('the two sides of the size ceiling', () => {
  test('agree, so a pre-flight refusal means what the relay would have said', () => {
    const { config } = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test' });
    expect(HANDOFF_MAX_BYTES).toBe(config.handoffMaxBytes);
  });
});

describe('the transport against the real router', () => {
  test('carries a bundle from one machine to another and clears it', async () => {
    const { db, link } = relay();
    const oldMachine = link('Old Laptop');
    const newMachine = link('New Laptop');
    const { bytes, phrase } = sealHandoff(Buffer.from('a whole machine'));

    const uploaded = await oldMachine.upload(bytes);
    expect(uploaded.sourceMachineName).toBe('Old Laptop');

    const offer = await newMachine.peek();
    expect(offer!.id).toBe(uploaded.id);
    expect(offer!.byteSize).toBe(bytes.length);

    const pulled = await newMachine.download();
    expect(pulled.id).toBe(uploaded.id);
    expect(openHandoff(pulled.sealed, phrase).toString()).toBe('a whole machine');

    await newMachine.acknowledge(pulled.id);
    expect(await newMachine.peek()).toBeNull();
    db.close();
  });

  test('does not offer a machine the bundle it prepared itself', async () => {
    const { db, link } = relay();
    const oldMachine = link('Old Laptop');
    await oldMachine.upload(sealHandoff(Buffer.from('mine')).bytes);

    expect(await oldMachine.peek()).toBeNull();
    expect(await link('New Laptop').peek()).not.toBeNull();
    db.close();
  });

  test('signs every call and declares the digest it signed for', async () => {
    let seen: Headers | undefined;
    const transport = createHandoffTransport({
      origin: 'http://relay.test',
      machineId: 'machine-1',
      sign: () => Buffer.alloc(64),
      fetchImpl: async (_input, init) => {
        seen = new Headers(init?.headers);
        return new Response('{"handoff":null}', { headers: { 'content-type': 'application/json' } });
      },
    });

    await transport.peek();
    expect(seen!.get('x-bodhi-issued-at')).not.toBeNull();
    expect(seen!.get('x-bodhi-signature')).not.toBeNull();

    await transport.upload(Buffer.from('bytes'));
    expect(seen!.get('x-bodhi-content-sha256')).toBe(
      crypto.createHash('sha256').update(Buffer.from('bytes')).digest('hex'),
    );
  });

  test('turns a refusal into something the window can show a person', async () => {
    const { db, link } = relay({ HANDOFF_MAX_BYTES: '64' });
    const oldMachine = link('Old Laptop');

    await expect(oldMachine.upload(Buffer.alloc(4096, 3))).rejects.toThrow(/Could not store the handoff \(413\)/);
    await expect(link('New Laptop').download()).rejects.toThrow(/Could not download the handoff \(404\)/);
    db.close();
  });

  test('treats a bundle already gone as the state the caller wanted', async () => {
    const { db, link } = relay();
    const newMachine = link('New Laptop');
    await expect(newMachine.acknowledge('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
    db.close();
  });
});
