import * as fs from 'fs';
import * as path from 'path';

const BASH_NAMES = new Set(['bash.exe', 'sh.exe', 'bash', 'sh']);
const INSTALL_PATHS = [String.raw`C:\Program Files\Git\bin\bash.exe`, String.raw`C:\Program Files (x86)\Git\bin\bash.exe`];
const EXECUTABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH');
  return (key ? env[key] ?? '' : '').split(path.win32.delimiter).filter(Boolean);
}

function gitOnPath(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  for (const dir of pathEntries(env)) {
    const git = EXECUTABLE_EXTENSIONS.map(ext => path.win32.join(dir, `git${ext}`)).find(p => exists(p));
    if (git) return git;
  }
  return null;
}

/**
 * Git Bash where the Claude CLI looks for it on Windows, in the same order, or
 * null when the CLI would run commands under PowerShell instead.
 */
export function findGitBash(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): string | null {
  const override = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && BASH_NAMES.has(path.win32.basename(override).toLowerCase()) && exists(override)) return override;
  const installed = INSTALL_PATHS.find(p => exists(p));
  if (installed) return installed;
  const git = gitOnPath(env, exists);
  const bash = git ? path.win32.join(git, '..', '..', 'bin', 'bash.exe') : null;
  return bash && exists(bash) ? bash : null;
}
