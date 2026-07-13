/**
 * Provider CLI detection (#97).
 *
 * Probes each registered provider's CLI the same way sessions launch it:
 * through the user's login shell on macOS/Linux (GUI-launched Electron does
 * not inherit shell PATH additions), via `wsl.exe bash` when the configured
 * shell is WSL, and via `where.exe` on native Windows. Command names come
 * from the static provider registry, never from user input.
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

function buildProbe(command: string): Probe {
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
  // Login (non-interactive) shell: picks up PATH from the user's profile
  // without interactive-rc noise on stdout.
  const wrap = (cmd: string): [string, string[]] => [shellInfo.shell, ['-l', '-c', cmd]];
  return { lookup: wrap(`command -v ${command}`), version: wrap(`${command} --version`) };
}

function run([file, args]: [string, string[]]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout?.toString() ?? '' });
    });
  });
}

/** Pick the first output line that looks like a version (contains a digit). */
function extractVersion(stdout: string): string | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && /\d/.test(l));
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
        docsUrl: p.setup.docsUrl,
        loginHint: p.setup.loginHint,
      };
    })
  );
}
