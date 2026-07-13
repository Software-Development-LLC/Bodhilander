import { ShellInfo } from './shell-detector';

/**
 * How to launch a command string under the user's shell: the executable to
 * spawn, how to wrap the command into argv, and the shell's syntax for
 * referencing an environment variable inside that command string. Single
 * source of truth for agent sessions, login ptys, and arena contestants.
 *
 * (Lives outside pty-manager so consumers that don't need node-pty — like
 * the arena engine and its tests — don't drag the native module in.)
 */
export interface ShellLaunch {
  shell: string;
  wrap(cmd: string): string[];
  envRef(name: string): string;
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
      return {
        shell: shellInfo.shell,
        wrap: (cmd) => ['-NoLogo', '-Command', cmd],
        envRef: (name) => `$env:${name}`,
      };
    }
    if (shellName.includes('cmd')) {
      return {
        shell: shellInfo.shell,
        wrap: (cmd) => ['/c', cmd],
        envRef: (name) => `"%${name}%"`,
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
