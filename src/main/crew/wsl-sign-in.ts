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
import { shQuote, wslAccountDir } from './wsl-run';

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
  handle('crew:windowsSignInCancel', () => {
    current()?.cancel();
  });
}

export type SignInOutcome =
  | { ok: true; accountUuid: string | null }
  | { ok: false; reason: 'no-token' | 'wrong-account' | 'no-encryption' | 'not-signed-in' | 'cancelled' | 'busy' | 'unavailable' };

const q = shQuote;

export class WslSignIn {
  private child: SignInChild | null = null;
  private tmpName: string | null = null;
  private busy = false;
  private cancelled = false;

  constructor(private readonly deps: WslSignInDeps) {}

  /** The TMPDIR a sign-in in progress uses, kept from the start sweep. */
  liveTmpNames(): string[] {
    return this.tmpName ? [this.tmpName] : [];
  }

  get active(): boolean {
    return this.busy;
  }

  /** Resolves when claude exits: a token stored, a login recorded, or why not. */
  async start(accountId: string): Promise<SignInOutcome> {
    if (this.busy) return { ok: false, reason: 'busy' };
    this.busy = true;
    this.cancelled = false;
    try {
      return await this.run(accountId);
    } finally {
      this.busy = false;
    }
  }

  private async run(accountId: string): Promise<SignInOutcome> {
    const d = this.deps;
    const configDir = wslAccountDir(accountId);
    const mode = d.signIn.mode();
    let tmpName = '';
    let tmpDir = '';
    let ready = false;
    try {
      await d.sh(`umask 077 && mkdir -p ${q(configDir)}`);
      tmpDir = await makeWslTmpDir(d.sh, CREW_UID, {
        add: (n) => {
          tmpName = n;
          this.tmpName = n;
          d.records.add(n);
        },
        remove: (n) => d.records.remove(n),
        list: () => d.records.list(),
      });
      ready = true;
    } finally {
      if (!ready) this.tmpName = null;
    }
    const command = mode === 'token' ? ['setup-token'] : ['/login'];
    const args = asCrew('env', `CLAUDE_CONFIG_DIR=${configDir}`, `TMPDIR=${tmpDir}`, 'BROWSER=true', CLAUDE_BIN, ...command);
    let output = '';
    let opened = false;
    const code = await new Promise<number | null>((resolve) => {
      if (this.cancelled) return resolve(null);
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
      this.tmpName = null;
      void removeWslTmpDir(d.sh, CREW_UID, d.records, tmpName).catch(() => undefined);
    });
    const now = d.now?.() ?? Date.now();
    if (mode === 'token') {
      if (code === null) return { ok: false, reason: 'cancelled' };
      const accountUuid = await this.accountUuid(configDir);
      const refused = d.signIn.storeToken(accountId, output, (t) => d.belongsTo(accountId, t, accountUuid), now);
      return refused ? { ok: false, reason: refused } : { ok: true, accountUuid };
    }
    if (code === null) return { ok: false, reason: 'cancelled' };
    const creds = await d.sh(`test -s ${q(posix.join(configDir, '.credentials.json'))}`);
    if (code !== 0 || creds.code !== 0) return { ok: false, reason: 'not-signed-in' };
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
    this.cancelled = true;
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
