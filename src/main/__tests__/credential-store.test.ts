/**
 * Where tokens are read from and rotations written to: the token file, or the
 * CLI's Keychain item on macOS. `security` is always a fake here; no spec
 * touches a real Keychain. Run with: bun test <this file>
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  credentialStoreFor,
  fileCredentialStore,
  keychainAccount,
  keychainCredentialStore,
  keychainService,
  SecurityExec,
} from '../credential-store';

const CONFIG_DIR = '/Users/test/claude-accounts/abc/.claude';
const SERVICE = 'Claude Code-credentials-ffebf9ef';

const ROTATED = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 9999, scopes: null, refreshTokenExpiresAt: null };

interface ExecCall { args: string[]; input?: string }

/** A fake `security` holding items by service, speaking the CLI's two verbs. */
function fakeSecurity(items: Map<string, string>, opts: { writeCode?: number; dropWrites?: boolean } = {}) {
  const calls: ExecCall[] = [];
  const exec: SecurityExec = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'find-generic-password') {
      const secret = items.get(args[args.indexOf('-s') + 1]);
      return secret === undefined ? { code: 44, stdout: '' } : { code: 0, stdout: `${secret}\n` };
    }
    const argv = args[0] === '-i' ? parseLine(input ?? '') : args;
    const service = argv[argv.indexOf('-s') + 1];
    const hex = argv[argv.indexOf('-X') + 1];
    if (!opts.dropWrites) items.set(service, Buffer.from(hex, 'hex').toString('utf-8'));
    return { code: opts.writeCode ?? 0, stdout: '' };
  };
  return { calls, exec };
}

function parseLine(line: string): string[] {
  return [...line.trim().matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
}

function item(oauth: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: oauth, ...extra });
}

const OAUTH = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1000, scopes: ['user:inference'], subscriptionType: 'max' };

describe('the CLI’s Keychain naming', () => {
  test('the service is the first 8 hex of sha256 of the config dir', () => {
    expect(keychainService(CONFIG_DIR)).toBe(SERVICE);
  });

  test('a decomposed path hashes as its composed form, as the CLI normalises it', () => {
    expect(keychainService('/Users/café/.claude')).toBe(keychainService('/Users/café/.claude'));
  });

  test('the account is the login name, or the CLI’s fallback for an unsafe one', () => {
    expect(keychainAccount({ USER: 'alice' }, () => 'unused')).toBe('alice');
    expect(keychainAccount({}, () => 'bob')).toBe('bob');
    expect(keychainAccount({ USER: 'a b' }, () => 'unused')).toBe('claude-code-user');
    expect(keychainAccount({}, () => { throw new Error('no passwd entry'); })).toBe('claude-code-user');
  });
});

describe('the Keychain store', () => {
  test('reads the item for the account’s config dir', async () => {
    const { calls, exec } = fakeSecurity(new Map([[SERVICE, item(OAUTH)]]));
    const creds = await keychainCredentialStore(exec, () => 'alice').read(CONFIG_DIR);
    expect(creds).toEqual({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1000, scopes: ['user:inference'] });
    expect(calls[0].args).toEqual(['find-generic-password', '-a', 'alice', '-w', '-s', SERVICE]);
  });

  test('a secret printed as hex is decoded', async () => {
    const { exec } = fakeSecurity(new Map([[SERVICE, Buffer.from(item(OAUTH)).toString('hex')]]));
    expect((await keychainCredentialStore(exec, () => 'alice').read(CONFIG_DIR))?.accessToken).toBe('old-access');
  });

  test('no item, or one that is not a credentials document, is null', async () => {
    const empty = fakeSecurity(new Map());
    expect(await keychainCredentialStore(empty.exec, () => 'alice').read(CONFIG_DIR)).toBeNull();
    const junk = fakeSecurity(new Map([[SERVICE, 'not json']]));
    expect(await keychainCredentialStore(junk.exec, () => 'alice').read(CONFIG_DIR)).toBeNull();
  });

  test('a rotation keeps every other field and goes in over stdin, never argv', async () => {
    const items = new Map([[SERVICE, item(OAUTH, { mcpOAuth: { keep: true } })]]);
    const { calls, exec } = fakeSecurity(items);
    expect(await keychainCredentialStore(exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED)).toBe(true);

    expect(JSON.parse(items.get(SERVICE)!)).toEqual({
      claudeAiOauth: { ...OAUTH, accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 9999 },
      mcpOAuth: { keep: true },
    });
    const write = calls.find(c => c.args[0] === '-i')!;
    expect(write.args).toEqual(['-i']);
    expect(write.input).toStartWith(`add-generic-password -U -a "alice" -s "${SERVICE}" -X "`);
    expect(write.input).not.toContain('new-access');
  });

  test('an item too long for one stdin line is written on argv, as the CLI does', async () => {
    const items = new Map([[SERVICE, item(OAUTH, { padding: 'x'.repeat(3000) })]]);
    const { calls, exec } = fakeSecurity(items);
    expect(await keychainCredentialStore(exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED)).toBe(true);
    expect(calls.some(c => c.args[0] === '-i')).toBe(false);
    expect(calls.find(c => c.args[0] === 'add-generic-password')?.args.slice(0, 6))
      .toEqual(['add-generic-password', '-U', '-a', 'alice', '-s', SERVICE]);
  });

  test('a failed write, or one that does not read back, is not saved', async () => {
    const failed = fakeSecurity(new Map([[SERVICE, item(OAUTH)]]), { writeCode: 1 });
    expect(await keychainCredentialStore(failed.exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED)).toBe(false);
    const dropped = fakeSecurity(new Map([[SERVICE, item(OAUTH)]]), { dropWrites: true });
    expect(await keychainCredentialStore(dropped.exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED)).toBe(false);
  });

  test('no item means nothing is written', async () => {
    const { calls, exec } = fakeSecurity(new Map());
    expect(await keychainCredentialStore(exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED)).toBe(false);
    expect(calls.map(c => c.args[0])).toEqual(['find-generic-password']);
  });
});

describe('the store for a platform', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-store-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const writeFile = () => fs.writeFileSync(path.join(dir, '.credentials.json'), item(OAUTH));

  test('off macOS the token file is the only store', async () => {
    const { calls, exec } = fakeSecurity(new Map());
    writeFile();
    const store = credentialStoreFor('linux', exec);
    expect(store).toBe(fileCredentialStore);
    expect((await store.read(dir))?.accessToken).toBe('old-access');
    expect(calls).toHaveLength(0);
    expect(credentialStoreFor('win32', exec).missing).toBe('no-credentials');
  });

  test('on macOS the Keychain wins, and its item takes the rotation', async () => {
    const items = new Map([[keychainService(dir), item({ ...OAUTH, accessToken: 'keychain-access' })]]);
    writeFile();
    const store = credentialStoreFor('darwin', fakeSecurity(items).exec);
    expect(store.missing).toBe('no-keychain-credentials');
    expect((await store.read(dir))?.accessToken).toBe('keychain-access');
    expect(await store.writeRotated(dir, ROTATED)).toBe(true);
    expect(JSON.parse(items.get(keychainService(dir))!).claudeAiOauth.accessToken).toBe('new-access');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf-8')).claudeAiOauth.accessToken).toBe('old-access');
  });

  test('on macOS with no Keychain item, a token file is read and written', async () => {
    writeFile();
    const store = credentialStoreFor('darwin', fakeSecurity(new Map()).exec);
    expect((await store.read(dir))?.accessToken).toBe('old-access');
    expect(await store.writeRotated(dir, ROTATED)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf-8')).claudeAiOauth.accessToken).toBe('new-access');
  });
});
