import * as path from 'path';
import { ShellInfo } from './shell-detector';

/**
 * How to launch a command string under the user's shell: the executable to
 * spawn, how to wrap the command into argv, and the shell's syntax for
 * referencing an environment variable inside that command string. Single
 * source of truth for agent sessions, login ptys, and arena contestants.
 *
 * Env-ref safety invariant (#106): every branch's envRef must expand AFTER
 * the shell parses the command, so the value is never re-parsed as shell
 * syntax. bash `"$VAR"` and PowerShell `$env:VAR` both satisfy this.
 * cmd.exe `%VAR%` does NOT — its expansion is textual and pre-parse, so a
 * value containing `"` or `&` breaks out of any quoting. Agent launches
 * from cmd.exe shells therefore route through PowerShell instead.
 *
 * (Lives outside pty-manager so consumers that don't need node-pty — like
 * the arena engine and its tests — don't drag the native module in.)
 */
export interface ShellLaunch {
  shell: string;
  wrap(cmd: string): string[];
  envRef(name: string): string;
}

function powershellLaunch(shell: string): ShellLaunch {
  return {
    shell,
    wrap: (cmd) => ['-NoLogo', '-Command', cmd],
    envRef: (name) => `$env:${name}`,
  };
}

export function getShellLaunch(shellInfo: ShellInfo): ShellLaunch {
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
      // cmd.exe cannot host env-ref launches safely (#106) — see the module
      // doc. Route through Windows PowerShell at its absolute path (always
      // present; PATH-poisoning-proof). Only agent/arena launches use this
      // wrapper; the user's plain cmd shell sessions are unaffected.
      const powershell = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
      );
      return powershellLaunch(powershell);
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
