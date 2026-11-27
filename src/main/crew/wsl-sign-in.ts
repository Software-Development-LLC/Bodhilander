/**
 * Sign in for Crew on Windows: claude runs inside BodhiCrew with the account's
 * config dir and a private TMPDIR; the URL opens in the Windows browser and the
 * code the person pastes is written to claude's stdin.
 */
import { posix } from 'path';
import { makeWslTmpDir, removeWslTmpDir, type DistroSh, type TmpRecords } from './run/sockets';
import type { CrewSignIn } from './crew-token';
import { asCrew } from './wsl';
import { CLAUDE_BIN } from './wsl-setup';
import { wslAccountDir } from './wsl-run';

const CREW_UID = 1000;
const URL_RE = /https:\/\/\S+/;

export interface SignInChild {
  write(text: string): void;
  onOutput(cb: (text: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  kill(): void;
}

export interface WslSignInDeps {
  signIn: CrewSignIn;
  sh: DistroSh;
  records: TmpRecords;
  spawn(args: string[]): SignInChild;
  openExternal(url: string): void;
  /** `accountUuid` is what the distro's .claude.json records after setup-token, when it records one. */
  belongsTo(accountId: string, token: string, accountUuid: string | null): boolean;
  now?(): number;
}

export function registerWindowsSignIn(handle: (channel: string, fn: (...args: unknown[]) => unknown) => void, current: () => WslSignIn | null): void {
  handle('crew:windowsSignIn', async (accountId: unknown): Promise<SignInOutcome> => {
    const s = current();
    if (!s || typeof accountId !== 'string') return { ok: false, reason: 'unavailable' };
    return s.start(accountId);
  });
  handle('crew:windowsSignInCode', (code: unknown) => typeof code === 'string' && (current()?.submitCode(code) ?? false));
  handle('crew:windowsSignInCancel', () => void current()?.cancel());
}

export type SignInOutcome =
  | { ok: true; accountUuid: string | null }
  | { ok: false; reason: 'no-token' | 'wrong-account' | 'no-encryption' | 'not-signed-in' | 'cancelled' | 'busy' | 'unavailable' };

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export class WslSignIn {
  private child: SignInChild | null = null;

  constructor(private readonly deps: WslSignInDeps) {}

  get active(): boolean {
    return this.child !== null;
  }

  /** Resolves when claude exits: a token stored, a login recorded, or why not. */
  async start(accountId: string): Promise<SignInOutcome> {
    if (this.child) return { ok: false, reason: 'busy' };
    const d = this.deps;
    const configDir = wslAccountDir(accountId);
    const mode = d.signIn.mode();
    await d.sh(`umask 077 && mkdir -p ${q(configDir)}`);
    let tmpName = '';
    const tmpDir = await makeWslTmpDir(d.sh, CREW_UID, {
      add: (n) => ((tmpName = n), d.records.add(n)),
      remove: (n) => d.records.remove(n),
      list: () => d.records.list(),
    });
    const command = mode === 'token' ? ['setup-token'] : ['/login'];
    const args = asCrew('env', `CLAUDE_CONFIG_DIR=${configDir}`, `TMPDIR=${tmpDir}`, 'BROWSER=true', CLAUDE_BIN, ...command);
    let output = '';
    let opened = false;
    const code = await new Promise<number | null>((resolve) => {
      const child = d.spawn(args);
      this.child = child;
      child.onOutput((text) => {
        output += text;
        const url = URL_RE.exec(output)?.[0];
        if (!opened && url) {
          opened = true;
          d.openExternal(url);
        }
      });
      child.onClose(resolve);
    }).finally(() => {
      this.child = null;
      void removeWslTmpDir(d.sh, CREW_UID, d.records, tmpName).catch(() => undefined);
    });
    const now = d.now?.() ?? Date.now();
    if (mode === 'token') {
      if (code === null) return { ok: false, reason: 'cancelled' };
      const accountUuid = await this.accountUuid(configDir);
      const refused = d.signIn.storeToken(accountId, output, (t) => d.belongsTo(accountId, t, accountUuid), now);
      return refused ? { ok: false, reason: refused } : { ok: true, accountUuid };
    }
    const creds = await d.sh(`test -s ${q(posix.join(configDir, '.credentials.json'))}`);
    if (creds.code !== 0) return { ok: false, reason: code === null ? 'cancelled' : 'not-signed-in' };
    d.signIn.recordSignIn(accountId, now);
    return { ok: true, accountUuid: await this.accountUuid(configDir) };
  }

  /** The code from the browser page, written to claude's stdin. */
  submitCode(code: string): boolean {
    const line = code.trim();
    if (!this.child || line === '' || /\s/.test(line)) return false;
    this.child.write(`${line}\n`);
    return true;
  }

  cancel(): void {
    this.child?.kill();
  }

  private async accountUuid(configDir: string): Promise<string | null> {
    const r = await this.deps.sh(`cat ${q(posix.join(configDir, '.claude.json'))}`);
    if (r.code !== 0) return null;
    try {
      const uuid = (JSON.parse(r.stdout) as { oauthAccount?: { accountUuid?: unknown } }).oauthAccount?.accountUuid;
      return typeof uuid === 'string' && uuid.trim() !== '' ? uuid.trim() : null;
    } catch {
      return null;
    }
  }
}
