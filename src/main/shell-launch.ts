import * as fs from 'fs';
import * as path from 'path';
import { ShellInfo } from './shell-detector';

/**
 * How to launch a command string under the user's shell: the executable to
 * spawn, how to wrap the command into argv, and the shell's syntax for
 * referencing an environment variable inside that command string. Single
 * source of truth for agent sessions, login ptys, and arena contestants.
 *
 * Env-ref safety invariant (#106): a launch's envRef must expand AFTER the
 * shell parses the command, so the value is never re-parsed as shell syntax.
 * bash `"$VAR"` and PowerShell `$env:VAR` both satisfy this. cmd.exe `%VAR%`
 * does NOT — its expansion is textual and pre-parse, so a value containing
 * `"` or `&` breaks out of any quoting.
 *
 * Callers declare via `needsEnvRef` whether they will interpolate a value
 * with envRef. When true, cmd.exe cannot host the launch safely and it is
 * rerouted through PowerShell. When false (e.g. the login pty, which just
 * runs `claude`), cmd.exe is used unchanged and envRef throws if misused.
 *
 * (Lives outside pty-manager so consumers that don't need node-pty — like
 * the arena engine and its tests — don't drag the native module in.)
 */
export interface ShellLaunch {
  shell: string;
  wrap(cmd: string): string[];
  envRef(name: string): string;
}

export interface ShellLaunchOptions {
  /**
   * Whether the caller will build the command with envRef (interpolating a
   * possibly-untrusted value). Gates the cmd.exe→PowerShell reroute (#106).
   */
  needsEnvRef: boolean;
}

function powershellLaunch(shell: string): ShellLaunch {
  return {
    shell,
    wrap: (cmd) => ['-NoLogo', '-Command', cmd],
    envRef: (name) => `$env:${name}`,
  };
}

/**
 * Absolute path to Windows PowerShell 5.1 (bundled with Windows). Absolute so
 * a poisoned PATH can't substitute the binary. Throws a clear error rather
 * than spawning an ENOENT if it is somehow absent (e.g. a pwsh-only image).
 */
function windowsPowershellPath(): string {
  // SystemRoot can be set-but-empty in some sandboxed processes; an empty or
  // whitespace value would make path.join produce a relative (PATH-relative)
  // path, so fall back to the default whenever it isn't a usable string.
  const raw = process.env.SystemRoot;
  const systemRoot = raw && raw.trim().length > 0 ? raw : 'C:\\Windows';
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Windows PowerShell not found at ${candidate}. Agent launches from a cmd.exe ` +
      `shell require it; set your Bodhilander shell to PowerShell or Git Bash instead.`
    );
  }
  return candidate;
}

export function getShellLaunch(shellInfo: ShellInfo, options: ShellLaunchOptions): ShellLaunch {
  if (shellInfo.isWSL) {
    // Launch the agent inside WSL
    return {
      shell: 'wsl.exe',
      wrap: (cmd) => [...shellInfo.args, '--', 'bash', '-c', cmd],
      envRef: (name) => `"$${name}"`,
    };
  }
  if (process.platform === 'win32') {
    const shellName = shellInfo.shell.toLowerCase();
    if (shellName.includes('powershell')) {
      return powershellLaunch(shellInfo.shell);
    }
    if (shellName.includes('cmd')) {
      // cmd.exe %VAR% expansion is textual and pre-parse (#106) — see the
      // module doc. When the caller interpolates a value via envRef, reroute
      // through PowerShell whose $env: expansion is parse-safe. Otherwise
      // (login pty), keep cmd.exe and make envRef throw so misuse is caught.
      if (options.needsEnvRef) {
        return powershellLaunch(windowsPowershellPath());
      }
      return {
        shell: shellInfo.shell,
        wrap: (cmd) => ['/c', cmd],
        envRef: () => {
          throw new Error('cmd.exe env-ref launch must set needsEnvRef (#106)');
        },
      };
    }
    // Assume bash-like shell (Git Bash, etc.)
    return {
      shell: shellInfo.shell,
      wrap: (cmd) => ['-c', cmd],
      envRef: (name) => `"$${name}"`,
    };
  }
  // macOS/Linux: run through interactive login shell
  return {
    shell: shellInfo.shell,
    wrap: (cmd) => ['-l', '-i', '-c', cmd],
    envRef: (name) => `"$${name}"`,
  };
}
