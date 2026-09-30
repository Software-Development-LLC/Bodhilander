import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as os from 'os';

import { UsageUnavailableReason } from '../shared/types';
import {
  oauthFromDocument,
  OAuthCredentials,
  readOAuthCredentials,
  RotatedTokens,
  withRotatedTokens,
  writeRotatedTokens,
} from './usage-credentials';

/**
 * Where an account's OAuth tokens live: `.credentials.json`, or on macOS the
 * CLI's Keychain item for that dir, reached through `/usr/bin/security` as the
 * CLI reaches it so the item's access list already trusts us. Nothing is logged.
 */

export interface CredentialStore {
  /** Why an account with no tokens here reads as unavailable. */
  readonly missing: UsageUnavailableReason;
  read(configDir: string): Promise<OAuthCredentials | null>;
  writeRotated(configDir: string, rotated: RotatedTokens): Promise<boolean>;
}

export type SecurityExec = (args: string[], input?: string) => Promise<{ code: number; stdout: string }>;

const SECURITY_PATH = '/usr/bin/security';
const SECURITY_TIMEOUT_MS = 5_000;
/** The longest line `security -i` accepts; the CLI switches to argv above it. */
const SECURITY_STDIN_LIMIT = 4032;
const FALLBACK_KEYCHAIN_ACCOUNT = 'claude-code-user';

export const fileCredentialStore: CredentialStore = {
  missing: 'no-credentials',
  read: async configDir => readOAuthCredentials(configDir),
  writeRotated: async (configDir, rotated) => writeRotatedTokens(configDir, rotated),
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
  const readDocument = async (configDir: string) => {
    const { code, stdout } = await exec(['find-generic-password', '-a', account(), '-w', '-s', keychainService(configDir)]);
    return code === 0 ? parseSecret(stdout) : null;
  };

  return {
    missing: 'no-keychain-credentials',
    read: async configDir => oauthFromDocument(await readDocument(configDir)),
    writeRotated: async (configDir, rotated) => {
      const doc = withRotatedTokens(await readDocument(configDir), rotated);
      if (!doc) return false;
      const hex = Buffer.from(JSON.stringify(doc), 'utf-8').toString('hex');
      const acct = account();
      const service = keychainService(configDir);
      const args = ['add-generic-password', '-U', '-a', acct, '-s', service, '-X', hex];
      const line = `add-generic-password -U -a "${acct}" -s "${service}" -X "${hex}"\n`;
      const { code } = line.length <= SECURITY_STDIN_LIMIT ? await exec(['-i'], line) : await exec(args);
      if (code !== 0) return false;
      return oauthFromDocument(await readDocument(configDir))?.accessToken === rotated.accessToken;
    },
  };
}

/**
 * The store for this platform. On macOS the Keychain comes first, and a token
 * file is used only when the Keychain holds nothing for the account.
 */
export function credentialStoreFor(platform: NodeJS.Platform, exec: SecurityExec = runSecurity): CredentialStore {
  if (platform !== 'darwin') return fileCredentialStore;
  const keychain = keychainCredentialStore(exec);
  return {
    missing: keychain.missing,
    read: async configDir => (await keychain.read(configDir)) ?? fileCredentialStore.read(configDir),
    writeRotated: async (configDir, rotated) => ((await keychain.read(configDir))
      ? keychain.writeRotated(configDir, rotated)
      : fileCredentialStore.writeRotated(configDir, rotated)),
  };
}
