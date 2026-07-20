/**
 * Provider CLI detection (#97).
 *
 * Probes each registered provider's CLI the same way sessions launch it:
 * through the user's interactive login shell on macOS/Linux (GUI-launched
 * Electron does not inherit shell PATH additions), via `wsl.exe bash` when
 * the configured shell is WSL, and via `where.exe` on native Windows.
 * Command names come from the static provider registry, never from user
 * input.
 */
import { execFile } from 'child_process';
import { listProviders } from './providers';
import { detectShell } from './shell-detector';
import { getPreference } from './repositories/preferences';
import { ProviderStatus } from '../shared/types';

const PROBE_TIMEOUT_MS = 10_000;

interface Probe {
  /** argv to check the command exists (exit 0 = installed). */
  lookup: [string, string[]];
  /** argv to fetch the version string (best effort). */
  version: [string, string[]];
}

/** Exported for tests — platform branches can't all run on one machine. */
export function buildProbe(command: string): Probe {
  const shellInfo = detectShell(getPreference('customShellPath') ?? '');

  if (shellInfo.isWSL) {
    const wrap = (cmd: string): [string, string[]] =>
      ['wsl.exe', [...shellInfo.args, '--', 'bash', '-lc', cmd]];
    return { lookup: wrap(`command -v ${command}`), version: wrap(`${command} --version`) };
  }
  if (process.platform === 'win32') {
    return {
      lookup: ['where.exe', [command]],
      version: ['cmd.exe', ['/c', `${command} --version`]],
    };
  }
  // Interactive login shell (-l -i), matching how sessions and arena
  // contestants actually launch. Interactive matters: installers commonly
  // add their bin dir to PATH in the interactive rc only (e.g. the grok
  // installer writes ~/.zshrc, which `-l -c` never reads), so a
  // non-interactive probe reports "not installed" for a CLI that launches
  // fine in a session. Interactive-rc side effects are contained: stdout
  // noise is tolerable (lookup only needs the exit code; extractVersion
  // skips non-version lines), rc prompts that read stdin see EOF because
  // run() ends the pipe, and PROBE_TIMEOUT_MS caps anything else.
  const wrap = (cmd: string): [string, string[]] => [shellInfo.shell, ['-l', '-i', '-c', cmd]];
  return { lookup: wrap(`command -v ${command}`), version: wrap(`${command} --version`) };
}

function run([file, args]: [string, string[]]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout?.toString() ?? '' });
    });
    // Interactive rc files can wait on stdin (e.g. Oh My Zsh's periodic
    // "update?" prompt). End the piped stdin so such reads hit EOF and
    // move on immediately instead of stalling until the probe timeout.
    child.stdin?.end();
  });
}

/** Matches a semver-looking token (1.2, v1.2.3, 2.1.207) — not just any digit. */
const VERSION_TOKEN = /\bv?\d+\.\d+(\.\d+)?\b/;

/**
 * Pick the first output line containing a semver-looking token. Best effort:
 * a pre-version banner that itself contains a version string (update nag,
 * runtime version) can still win, but plain text banners are skipped.
 * Exported for tests.
 */
export function extractVersion(stdout: string): string | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => VERSION_TOKEN.test(l));
  return line ? line.slice(0, 100) : null;
}

async function probeCommand(command: string): Promise<{ installed: boolean; version: string | null }> {
  const probe = buildProbe(command);
  const lookup = await run(probe.lookup);
  if (!lookup.ok) {
    return { installed: false, version: null };
  }
  const version = await run(probe.version);
  return { installed: true, version: version.ok ? extractVersion(version.stdout) : null };
}

/** Probe every registered provider concurrently. */
export function detectProviders(): Promise<ProviderStatus[]> {
  return Promise.all(
    listProviders().map(async (p): Promise<ProviderStatus> => {
      const { installed, version } = await probeCommand(p.command);
      return {
        id: p.id,
        name: p.name,
        command: p.command,
        installed,
        version,
        installHint: p.setup.installHint,
        installCommand: p.setup.installCommand ?? null,
        docsUrl: p.setup.docsUrl,
        loginHint: p.setup.loginHint,
      };
    })
  );
}
