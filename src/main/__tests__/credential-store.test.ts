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
  CredentialRead,
  fileCredentialStore,
  hasCredentials,
  keychainAccount,
  keychainCredentialStore,
  keychainService,
  SecurityExec,
  StoreRead,
} from '../credential-store';

const CONFIG_DIR = '/Users/test/claude-accounts/abc/.claude';
const SERVICE = 'Claude Code-credentials-ffebf9ef';

const ROTATED = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 9999, scopes: null, refreshTokenExpiresAt: null };

interface ExecCall { args: string[]; input?: string }

/** A fake `security` holding items by service, speaking the CLI's two verbs. */
function fakeSecurity(items: Map<string, string>, opts: { writeCode?: number; dropWrites?: boolean; findCode?: number } = {}) {
  const calls: ExecCall[] = [];
  const exec: SecurityExec = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'find-generic-password') {
      if (opts.findCode !== undefined) return { code: opts.findCode, stdout: '' };
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

const accessToken = (read: CredentialRead) => (hasCredentials(read) ? read.accessToken : read);

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
    expect(creds).toEqual({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1000, scopes: ['user:inference'], source: 'keychain' });
    expect(calls[0].args).toEqual(['find-generic-password', '-a', 'alice', '-w', '-s', SERVICE]);
  });

  test('a secret printed as hex is decoded', async () => {
    const { exec } = fakeSecurity(new Map([[SERVICE, Buffer.from(item(OAUTH)).toString('hex')]]));
    expect(accessToken(await keychainCredentialStore(exec, () => 'alice').read(CONFIG_DIR))).toBe('old-access');
  });

  test('no item, or one that is not a credentials document, is no Keychain sign-in', async () => {
    const empty = fakeSecurity(new Map());
    expect(await keychainCredentialStore(empty.exec, () => 'alice').read(CONFIG_DIR)).toBe('no-keychain-credentials');
    const junk = fakeSecurity(new Map([[SERVICE, 'not json']]));
    expect(await keychainCredentialStore(junk.exec, () => 'alice').read(CONFIG_DIR)).toBe('no-keychain-credentials');
  });

  test.each([[36, 'locked'], [51, 'access denied'], [-1, 'security failed to run']])(
    'exit %d (%s) is an unavailable Keychain, not a missing sign-in',
    async (code) => {
      const { exec } = fakeSecurity(new Map([[SERVICE, item(OAUTH)]]), { findCode: code });
      expect(await keychainCredentialStore(exec, () => 'alice').read(CONFIG_DIR)).toBe('keychain-unavailable');
    },
  );

  test('a rotation keeps every other field and goes in over stdin, never argv', async () => {
    const items = new Map([[SERVICE, item(OAUTH, { mcpOAuth: { keep: true } })]]);
    const { calls, exec } = fakeSecurity(items);
    expect(await keychainCredentialStore(exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED, { source: 'keychain', spent: 'old-refresh' })).toBe(true);

    expect(JSON.parse(items.get(SERVICE)!)).toEqual({
      claudeAiOauth: { ...OAUTH, accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 9999 },
      mcpOAuth: { keep: true },
    });
    const write = calls.find(c => c.args[0] === '-i')!;
    expect(write.args).toEqual(['-i']);
    expect(write.input).toStartWith(`add-generic-password -U -a "alice" -s "${SERVICE}" -X "`);
    expect(write.input).toEndWith('"\n');
    expect(write.input).not.toContain('new-access');
  });

  test('an item too long for one stdin line is written on argv, as the CLI does', async () => {
    const items = new Map([[SERVICE, item(OAUTH, { padding: 'x'.repeat(3000) })]]);
    const { calls, exec } = fakeSecurity(items);
    expect(await keychainCredentialStore(exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED, { source: 'keychain', spent: 'old-refresh' })).toBe(true);
    expect(calls.some(c => c.args[0] === '-i')).toBe(false);
    expect(calls.find(c => c.args[0] === 'add-generic-password')?.args.slice(0, 6))
      .toEqual(['add-generic-password', '-U', '-a', 'alice', '-s', SERVICE]);
  });

  test('a failed write, or one that does not read back, is not saved', async () => {
    const failed = fakeSecurity(new Map([[SERVICE, item(OAUTH)]]), { writeCode: 1 });
    expect(await keychainCredentialStore(failed.exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED, { source: 'keychain', spent: 'old-refresh' })).toBe(false);
    const dropped = fakeSecurity(new Map([[SERVICE, item(OAUTH)]]), { dropWrites: true });
    expect(await keychainCredentialStore(dropped.exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED, { source: 'keychain', spent: 'old-refresh' })).toBe(false);
  });

  test('an item no longer holding the replaced refresh token is not written over', async () => {
    const items = new Map([[SERVICE, item({ ...OAUTH, refreshToken: 'login-refresh' })]]);
    const { calls, exec } = fakeSecurity(items);
    const target = { source: 'keychain' as const, spent: 'old-refresh' };
    expect(await keychainCredentialStore(exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED, target)).toBe(false);
    expect(JSON.parse(items.get(SERVICE)!).claudeAiOauth.refreshToken).toBe('login-refresh');
    expect(calls.map(c => c.args[0])).toEqual(['find-generic-password']);
  });

  test('no item means nothing is written', async () => {
    const { calls, exec } = fakeSecurity(new Map());
    expect(await keychainCredentialStore(exec, () => 'alice').writeRotated(CONFIG_DIR, ROTATED, { source: 'keychain', spent: 'old-refresh' })).toBe(false);
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
    expect(accessToken(await store.read(dir))).toBe('old-access');
    expect(calls).toHaveLength(0);
    expect(await credentialStoreFor('win32', exec).read(path.join(dir, 'none'))).toBe('no-credentials');
  });

  const readFile = () => JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf-8')).claudeAiOauth;
  const sourceOf = (read: StoreRead) => (hasCredentials(read) ? read.source : read);

  test('on macOS the Keychain wins, and its item takes the rotation', async () => {
    const items = new Map([[keychainService(dir), item({ ...OAUTH, accessToken: 'keychain-access' })]]);
    writeFile();
    const store = credentialStoreFor('darwin', fakeSecurity(items).exec);
    const read = await store.read(dir);
    expect(accessToken(read)).toBe('keychain-access');
    expect(sourceOf(read)).toBe('keychain');
    expect(await store.writeRotated(dir, ROTATED, { source: 'keychain', spent: 'old-refresh' })).toBe(true);
    expect(JSON.parse(items.get(keychainService(dir))!).claudeAiOauth.accessToken).toBe('new-access');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf-8')).claudeAiOauth.accessToken).toBe('old-access');
  });

  test('on macOS with no Keychain item, a token file is read and written', async () => {
    writeFile();
    const { calls, exec } = fakeSecurity(new Map());
    const store = credentialStoreFor('darwin', exec);
    const read = await store.read(dir);
    expect(sourceOf(read)).toBe('file');
    expect(await store.writeRotated(dir, ROTATED, { source: 'file', spent: 'old-refresh' })).toBe(true);
    expect(readFile().accessToken).toBe('new-access');
    expect(calls.map(c => c.args[0])).toEqual(['find-generic-password']);
  });

  test('a Keychain read that fails at write time leaves the token file alone', async () => {
    const service = keychainService(dir);
    const items = new Map([[service, item(OAUTH)]]);
    writeFile();
    const { calls, exec: healthy } = fakeSecurity(items);
    const locked = fakeSecurity(items, { findCode: 36 });
    let exec = healthy;
    const store = credentialStoreFor('darwin', (args, input) => exec(args, input));
    const read = await store.read(dir);
    expect(sourceOf(read)).toBe('keychain');
    exec = locked.exec;

    expect(await store.writeRotated(dir, ROTATED, { source: 'keychain', spent: 'old-refresh' })).toBe(false);
    expect(readFile().accessToken).toBe('old-access');
    expect(JSON.parse(items.get(service)!).claudeAiOauth.accessToken).toBe('old-access');
    expect([...calls, ...locked.calls].map(c => c.args[0])).toEqual(['find-generic-password', 'find-generic-password']);
  });

  test('on macOS with neither, the reason is the Keychain’s', async () => {
    expect(await credentialStoreFor('darwin', fakeSecurity(new Map()).exec).read(dir)).toBe('no-keychain-credentials');
    const locked = fakeSecurity(new Map(), { findCode: 36 });
    expect(await credentialStoreFor('darwin', locked.exec).read(dir)).toBe('keychain-unavailable');
  });

  test('reading from one store never falls back to the other', async () => {
    writeFile();
    const locked = credentialStoreFor('darwin', fakeSecurity(new Map(), { findCode: 36 }).exec);
    expect(await locked.readFrom(dir, 'keychain')).toBe('keychain-unavailable');
    const items = new Map([[keychainService(dir), item({ ...OAUTH, accessToken: 'keychain-access' })]]);
    const both = credentialStoreFor('darwin', fakeSecurity(items).exec);
    expect(accessToken(await both.readFrom(dir, 'file'))).toBe('old-access');
    expect(accessToken(await both.readFrom(dir, 'keychain'))).toBe('keychain-access');
  });

  test('a token file that is gone reads apart from one that is there but unreadable', async () => {
    expect(await fileCredentialStore.readFrom(dir, 'file')).toBe('no-credentials');
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":');
    expect(await fileCredentialStore.readFrom(dir, 'file')).toBe('credentials-unreadable');
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
    expect(await fileCredentialStore.readFrom(dir, 'file')).toBe('no-credentials');
    writeFile();
    expect(sourceOf(await fileCredentialStore.readFrom(dir, 'file'))).toBe('file');
  });

  test('on macOS an unavailable Keychain still falls back to a token file', async () => {
    writeFile();
    const { calls, exec } = fakeSecurity(new Map(), { findCode: 36 });
    const store = credentialStoreFor('darwin', exec);
    const read = await store.read(dir);
    expect(sourceOf(read)).toBe('file');
    expect(await store.writeRotated(dir, ROTATED, { source: 'file', spent: 'old-refresh' })).toBe(true);
    expect(readFile().accessToken).toBe('new-access');
    expect(calls.map(c => c.args[0])).toEqual(['find-generic-password']);
  });
});
