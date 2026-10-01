import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';

import { UsageUnavailableReason } from '../shared/types';
import {
  credentialsPath,
  oauthFromDocument,
  OAuthCredentials,
  readOAuthCredentials,
  readRaw,
  RotatedTokens,
  withRotatedTokens,
  writeRotatedTokens,
} from './usage-credentials';

/**
 * Where an account's OAuth tokens live: `.credentials.json`, or on macOS the
 * CLI's Keychain item for that dir, reached through `/usr/bin/security` as the
 * CLI reaches it so the item's access list already trusts us. Nothing is logged.
 */

export type CredentialSource = 'file' | 'keychain';

/** Tokens, and the store they came from, which is the one a rotation of them goes back to. */
export interface StoredCredentials extends OAuthCredentials {
  source: CredentialSource;
}

/** The account's tokens, or why there are none to use. */
export type CredentialRead = StoredCredentials | UsageUnavailableReason;

/** One store's own reading, which can tell a token file that is there but unreadable from one that is gone. */
export type StoreRead = CredentialRead | 'credentials-unreadable';

/** Where a rotation goes, and the refresh token it replaced, which that store must still hold. */
export interface WriteTarget {
  source: CredentialSource;
  spent: string | null;
}

export interface CredentialStore {
  read(configDir: string): Promise<CredentialRead>;
  /** What one store alone holds, with no fallback to the other. */
  readFrom(configDir: string, source: CredentialSource): Promise<StoreRead>;
  writeRotated(configDir: string, rotated: RotatedTokens, target: WriteTarget): Promise<boolean>;
}

export function hasCredentials(read: StoreRead): read is StoredCredentials {
  return typeof read !== 'string';
}

export type SecurityExec = (args: string[], input?: string) => Promise<{ code: number; stdout: string }>;

const SECURITY_PATH = '/usr/bin/security';
const SECURITY_TIMEOUT_MS = 5_000;
/** The longest line `security -i` accepts; the CLI switches to argv above it. */
const SECURITY_STDIN_LIMIT = 4032;
/** `security`'s exit status when the item does not exist. */
const SECURITY_ITEM_NOT_FOUND = 44;
const FALLBACK_KEYCHAIN_ACCOUNT = 'claude-code-user';

function withSource(creds: OAuthCredentials | null, source: CredentialSource): StoredCredentials | null {
  return creds ? { ...creds, source } : null;
}

function isAbsent(file: string): boolean {
  try {
    fs.statSync(file);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export const fileCredentialStore: CredentialStore = {
  read: async configDir => withSource(readOAuthCredentials(configDir), 'file') ?? 'no-credentials',
  readFrom: async configDir => {
    const doc = readRaw(configDir);
    const creds = withSource(oauthFromDocument(doc), 'file');
    if (creds) return creds;
    return doc || isAbsent(credentialsPath(configDir)) ? 'no-credentials' : 'credentials-unreadable';
  },
  writeRotated: async (configDir, rotated, { spent }) => writeRotatedTokens(configDir, rotated, spent),
};

/** The CLI's Keychain service for a CLAUDE_CONFIG_DIR. */
export function keychainService(configDir: string): string {
  const hash = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').substring(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** The CLI's Keychain account attribute: the login name, when it is a safe one. */
export function keychainAccount(
  env: NodeJS.ProcessEnv = process.env,
  username: () => string = () => os.userInfo().username,
): string {
  let name: string;
  try {
    name = env.USER?.length ? env.USER : username();
  } catch {
    return FALLBACK_KEYCHAIN_ACCOUNT;
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : FALLBACK_KEYCHAIN_ACCOUNT;
}

function parseDocument(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `security -w` prints a secret holding non-printable bytes as hex. */
function parseSecret(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  const hex = /^(?:[0-9a-f]{2})+$/i.test(text) ? Buffer.from(text, 'hex').toString('utf-8') : null;
  return parseDocument(text) ?? parseDocument(hex);
}

export const runSecurity: SecurityExec = (args, input) => new Promise(resolve => {
  const child = spawn(SECURITY_PATH, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: SECURITY_TIMEOUT_MS });
  let stdout = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.on('error', () => resolve({ code: -1, stdout: '' }));
  child.on('close', code => resolve({ code: code ?? -1, stdout }));
  child.stdin.on('error', () => undefined);
  child.stdin.end(input ?? '');
});

/**
 * The Keychain item as the CLI keeps it. A write goes in as hex over stdin, the
 * way the CLI writes it, and is read back; like the CLI, an item too long for
 * one stdin line goes on argv instead.
 */
export function keychainCredentialStore(
  exec: SecurityExec,
  account: () => string = () => keychainAccount(),
): CredentialStore {
  const readItem = async (configDir: string) => {
    const { code, stdout } = await exec(['find-generic-password', '-a', account(), '-w', '-s', keychainService(configDir)]);
    return { code, doc: code === 0 ? parseSecret(stdout) : null };
  };
  const readDocument = async (configDir: string) => (await readItem(configDir)).doc;

  const read = async (configDir: string): Promise<CredentialRead> => {
    const { code, doc } = await readItem(configDir);
    if (code !== 0 && code !== SECURITY_ITEM_NOT_FOUND) return 'keychain-unavailable';
    return withSource(oauthFromDocument(doc), 'keychain') ?? 'no-keychain-credentials';
  };

  return {
    read,
    readFrom: read,
    writeRotated: async (configDir, rotated, { spent }) => {
      const doc = withRotatedTokens(await readDocument(configDir), rotated, spent);
      if (!doc) return false;
      const hex = Buffer.from(JSON.stringify(doc), 'utf-8').toString('hex');
      const acct = account();
      const service = keychainService(configDir);
      const args = ['add-generic-password', '-U', '-a', acct, '-s', service, '-X', hex];
      const line = `add-generic-password -U -a "${acct}" -s "${service}" -X "${hex}"\n`;
      // The old refresh token is already spent, so a long item takes the CLI's argv route rather than lose the pair.
      const { code } = line.length <= SECURITY_STDIN_LIMIT ? await exec(['-i'], line) : await exec(args);
      if (code !== 0) return false;
      return oauthFromDocument(await readDocument(configDir))?.accessToken === rotated.accessToken;
    },
  };
}

/**
 * The store for this platform. On macOS the Keychain comes first, and a token
 * file is used only when the Keychain yields nothing for the account; with no
 * file either, the reason given is the Keychain's. A rotation goes back to the
 * store its tokens were read from, never to the other one.
 */
export function credentialStoreFor(platform: NodeJS.Platform, exec: SecurityExec = runSecurity): CredentialStore {
  if (platform !== 'darwin') return fileCredentialStore;
  const keychain = keychainCredentialStore(exec);
  return {
    read: async configDir => {
      const fromKeychain = await keychain.read(configDir);
      if (hasCredentials(fromKeychain)) return fromKeychain;
      const fromFile = await fileCredentialStore.read(configDir);
      return hasCredentials(fromFile) ? fromFile : fromKeychain;
    },
    readFrom: (configDir, source) => (source === 'keychain' ? keychain : fileCredentialStore).readFrom(configDir, source),
    writeRotated: (configDir, rotated, target) => (target.source === 'keychain' ? keychain : fileCredentialStore)
      .writeRotated(configDir, rotated, target),
  };
}
