/**
 * What a config dir must contain before a surface may call the account logged
 * in, pinned against the layouts Claude Code leaves on each platform. Nothing
 * here is mocked: the subject is a directory read.
 */

// Run with: bun test src/main/__tests__/account-identity.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LOGIN_ARTIFACTS, resolveAccountIdentity, withAccountIdentity } from '../account-identity';
import { ClaudeAccount } from '../../shared/types';

let configDir = '';

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-identity-'));
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function write(name: string, contents: unknown): void {
  fs.writeFileSync(path.join(configDir, name), JSON.stringify(contents));
}

/**
 * The macOS layout: tokens live in the Keychain, so the config dir holds no
 * credential file at all — only the profile block .claude.json gains at login.
 * Trimmed to the keys the resolver reads; the real file carries ~20 more.
 */
function writeMacOsLayout(emailAddress = 'will@acme.test'): void {
  write('.claude.json', {
    userID: 'abc123',
    oauthAccount: {
      accountUuid: '11111111-2222-3333-4444-555555555555',
      emailAddress,
      organizationName: 'Acme',
      organizationUuid: '66666666-7777-8888-9999-000000000000',
    },
  });
}

/** The Linux/Windows layout: the same profile block plus a plaintext token file. */
function writeTokenFileLayout(): void {
  write('.credentials.json', {
    claudeAiOauth: {
      accessToken: 'not-a-real-token',
      subscriptionEmail: 'will@linux.test',
    },
  });
}

/** A dir Claude Code has started in but nobody has logged into. */
function writeFreshLayout(): void {
  write('.claude.json', {
    userID: 'abc123',
    hasCompletedOnboarding: false,
    projects: {},
  });
}

function account(overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    id: 'a1',
    label: 'Personal',
    configDir,
    email: null,
    color: '#61afef',
    isDefault: false,
    createdAt: new Date(),
    lastUsedAt: null,
    ...overrides,
  };
}

describe('resolveAccountIdentity', () => {
  test('reads a macOS login as logged in, though it never writes a credential file', () => {
    writeMacOsLayout();
    expect(fs.existsSync(path.join(configDir, '.credentials.json'))).toBe(false);
    expect(resolveAccountIdentity(configDir)).toEqual({
      loggedIn: true,
      email: 'will@acme.test',
    });
  });

  test('reads the plaintext-token layout as logged in, and takes its email', () => {
    writeTokenFileLayout();
    expect(resolveAccountIdentity(configDir)).toEqual({
      loggedIn: true,
      email: 'will@linux.test',
    });
  });

  test('a token file with no address still proves the login', () => {
    write('.credentials.json', { claudeAiOauth: { accessToken: 'not-a-real-token' } });
    expect(resolveAccountIdentity(configDir)).toEqual({ loggedIn: true, email: null });
  });

  test('the older auth.json name is honoured too', () => {
    write('auth.json', { account: { email: 'will@old.test' } });
    expect(resolveAccountIdentity(configDir)).toEqual({
      loggedIn: true,
      email: 'will@old.test',
    });
  });

  test('a profile with a uuid but no address is a login, not an anonymous dir', () => {
    write('.claude.json', { oauthAccount: { accountUuid: 'u1', organizationName: 'Acme' } });
    expect(resolveAccountIdentity(configDir)).toEqual({ loggedIn: true, email: null });
  });

  test('a started-but-never-logged-in dir is logged out', () => {
    writeFreshLayout();
    expect(resolveAccountIdentity(configDir)).toEqual({ loggedIn: false, email: null });
  });

  test('an empty config dir is logged out', () => {
    expect(resolveAccountIdentity(configDir)).toEqual({ loggedIn: false, email: null });
  });

  test('a dir that does not exist is logged out rather than throwing', () => {
    expect(resolveAccountIdentity(path.join(configDir, 'nope'))).toEqual({
      loggedIn: false,
      email: null,
    });
  });

  test('a config dir the row never recorded is logged out', () => {
    expect(resolveAccountIdentity('')).toEqual({ loggedIn: false, email: null });
  });

  test('a truncated .claude.json falls through to the token file beside it', () => {
    fs.writeFileSync(path.join(configDir, '.claude.json'), '{"oauthAcc');
    writeTokenFileLayout();
    expect(resolveAccountIdentity(configDir)).toEqual({
      loggedIn: true,
      email: 'will@linux.test',
    });
  });

  test('a truncated token file still counts, since only writing it creates it', () => {
    fs.writeFileSync(path.join(configDir, '.credentials.json'), '{"claudeAiOau');
    expect(resolveAccountIdentity(configDir)).toEqual({ loggedIn: true, email: null });
  });

  // Claude Code rewrites .claude.json about once a minute. On the macOS layout
  // there is no token file to fall through to, so reading a torn file as
  // logged out is the reported bug coming back at random.
  test('a torn read on the macOS layout is unknown, never logged out', () => {
    fs.writeFileSync(path.join(configDir, '.claude.json'), '{"oauthAccount": {"emai');
    expect(fs.existsSync(path.join(configDir, '.credentials.json'))).toBe(false);
    expect(resolveAccountIdentity(configDir).loggedIn).toBeUndefined();
  });

  test('an unparseable .claude.json is unknown rather than evidence of nothing', () => {
    fs.writeFileSync(path.join(configDir, '.claude.json'), 'not json at all');
    expect(resolveAccountIdentity(configDir).loggedIn).toBeUndefined();
  });

  test('a file holding bare JSON null is no login, not an unreadable one', () => {
    fs.writeFileSync(path.join(configDir, '.claude.json'), 'null');
    expect(resolveAccountIdentity(configDir)).toEqual({ loggedIn: false, email: null });
  });

  test('an oauthAccount of the wrong shape is not mistaken for a profile', () => {
    write('.claude.json', { oauthAccount: 'will@acme.test' });
    expect(resolveAccountIdentity(configDir)).toEqual({ loggedIn: false, email: null });
  });

  test('a blank address is as unidentified as a missing one', () => {
    write('.claude.json', { oauthAccount: { accountUuid: 'u1', emailAddress: '  ' } });
    expect(resolveAccountIdentity(configDir)).toEqual({ loggedIn: true, email: null });
  });

  test('an address is trimmed, so the chip spends its one line on the address', () => {
    write('.claude.json', { oauthAccount: { emailAddress: ' will@acme.test\n' } });
    expect(resolveAccountIdentity(configDir).email).toBe('will@acme.test');
  });

  test('the profile wins over a stale token file, being what the login refreshes', () => {
    writeMacOsLayout('current@acme.test');
    writeTokenFileLayout();
    expect(resolveAccountIdentity(configDir).email).toBe('current@acme.test');
  });
});

describe('LOGIN_ARTIFACTS', () => {
  test('covers every file the resolver can draw a conclusion from', () => {
    expect([...LOGIN_ARTIFACTS].sort()).toEqual(
      ['.claude.json', '.credentials.json', 'auth.json']
    );
  });
});

describe('withAccountIdentity', () => {
  test('a used account resolves logged in, whatever the row remembers', () => {
    writeMacOsLayout();
    const resolved = withAccountIdentity(account({ email: null }));
    expect(resolved.loggedIn).toBe(true);
    expect(resolved.email).toBe('will@acme.test');
  });

  test('an account with no evidence anywhere is reported logged out', () => {
    writeFreshLayout();
    const resolved = withAccountIdentity(account({ email: null }));
    expect(resolved.loggedIn).toBe(false);
    expect(resolved.email).toBeNull();
  });

  // The login flow records an address on every platform now, so every account
  // will have one. If a stored address could outvote a readable config dir, a
  // logout would never surface again on any of them.
  test('a readable dir showing no login outranks the address the row kept', () => {
    writeFreshLayout();
    const resolved = withAccountIdentity(account({ email: 'stored@acme.test' }));
    expect(resolved.loggedIn).toBe(false);
  });

  test('a config dir that is gone is logged out, however healthy the row looks', () => {
    const resolved = withAccountIdentity(
      account({ configDir: path.join(configDir, 'moved'), email: 'stored@acme.test' })
    );
    expect(resolved.loggedIn).toBe(false);
  });

  test('a stored email stands in only where the dir could not be read', () => {
    fs.writeFileSync(path.join(configDir, '.claude.json'), '{"oauthAcc');
    const resolved = withAccountIdentity(account({ email: 'stored@acme.test' }));
    expect(resolved.loggedIn).toBe(true);
    expect(resolved.email).toBe('stored@acme.test');
  });

  test('an unreadable dir and no stored email makes no claim at all', () => {
    fs.writeFileSync(path.join(configDir, '.claude.json'), '{"oauthAcc');
    expect(withAccountIdentity(account({ email: null })).loggedIn).toBeUndefined();
  });

  test('a stored blank email is no evidence at all', () => {
    const resolved = withAccountIdentity(account({ email: '   ' }));
    expect(resolved.loggedIn).toBe(false);
    expect(resolved.email).toBeNull();
  });

  test('the live profile overrides an email the row captured under an old login', () => {
    writeMacOsLayout('new@acme.test');
    expect(withAccountIdentity(account({ email: 'old@acme.test' })).email).toBe('new@acme.test');
  });

  test('the rest of the row is carried through untouched', () => {
    writeMacOsLayout();
    const row = account({ label: 'Work', color: '#98c379', isDefault: true });
    const resolved = withAccountIdentity(row);
    expect(resolved.id).toBe('a1');
    expect(resolved.label).toBe('Work');
    expect(resolved.color).toBe('#98c379');
    expect(resolved.isDefault).toBe(true);
    expect(resolved.configDir).toBe(configDir);
  });

  test('the stored row is not mutated, so a caller cannot cache a resolved copy', () => {
    writeMacOsLayout();
    const row = account({ email: null });
    withAccountIdentity(row);
    expect(row.email).toBeNull();
    expect(row.loggedIn).toBeUndefined();
  });
});
