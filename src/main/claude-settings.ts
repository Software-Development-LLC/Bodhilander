/**
 * Claude Code's per-config-dir `settings.json`: where it lives, reading it,
 * writing it, and the one flag the run engine has to set on it.
 *
 * Split out of `mcp-config.ts` deliberately as a LEAF module: it imports only
 * `fs`/`path`/`os` (+ `electron-log`), never the `electron` `app` singleton.
 * `mcp-config` pulls `app` in for the hook-script path, and a module that
 * imports `app` cannot be imported by a unit test that hasn't mocked all of
 * electron. The gate launcher needs `ensureDangerousModeAccepted` right before
 * a `bypass` spawn, and its tests must stay app-free -- so the settings
 * primitives live here and `mcp-config` re-uses (and re-exports) them.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import log from 'electron-log';

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookConfig {
  matcher: string;
  hooks: HookCommand[];
}

export interface ClaudeSettingsConfig {
  hooks?: {
    PreToolUse?: HookConfig[];
    PostToolUse?: HookConfig[];
    Stop?: HookConfig[];
    Notification?: HookConfig[];
    [key: string]: HookConfig[] | undefined;
  };
  /**
   * Set once the `--dangerously-skip-permissions` disclaimer has been accepted
   * for this config dir. Claude Code writes it when a person accepts the prompt
   * interactively; without it a `--bg` gate under the `bypass` posture exits 1
   * instead of launching. See `ensureDangerousModeAccepted`.
   */
  skipDangerousModePermissionPrompt?: boolean;
  [key: string]: unknown;
}

/**
 * The config dir a settings file lives in: the one passed (an isolated account)
 * or `~/.claude` for the ambient default.
 */
export function resolveConfigDir(configDir?: string): string {
  return configDir ?? path.join(os.homedir(), '.claude');
}

/**
 * Path to Claude Code's settings file. Hooks and the bypass-disclaimer flag are
 * configured here. Default: `~/.claude/settings.json`; with a configDir passed:
 * `<configDir>/settings.json`.
 */
export function getClaudeSettingsPath(configDir?: string): string {
  return path.join(resolveConfigDir(configDir), 'settings.json');
}

/**
 * Read Claude Code settings for the given config dir. A missing or unreadable
 * file reads as an empty object, so a caller merges into a known shape.
 */
export function readClaudeSettings(configDir?: string): ClaudeSettingsConfig {
  const settingsPath = getClaudeSettingsPath(configDir);

  try {
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    log.warn('[Claude Settings] Failed to read settings:', err);
  }

  return {};
}

/**
 * Write Claude Code settings for the given config dir.
 *
 * Temp file + atomic rename: settings.json is the user's own Claude Code
 * configuration (permissions, model, statusLine, their own hooks) and we
 * rewrite it on every launch, so a torn write from a crash or power loss would
 * cost them real state. rename() within a directory is atomic on POSIX and NTFS.
 */
export function writeClaudeSettings(settings: ClaudeSettingsConfig, configDir?: string): boolean {
  const settingsPath = getClaudeSettingsPath(configDir);

  try {
    const claudeDir = path.dirname(settingsPath);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    const tmpPath = `${settingsPath}.bodhilander.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmpPath, settingsPath);
    return true;
  } catch (err) {
    log.error('[Claude Settings] Failed to write settings:', err);
    return false;
  }
}

/**
 * Pre-accept the `--dangerously-skip-permissions` disclaimer for one config dir.
 *
 * A gate spawned under the `bypass` posture runs the CLI with
 * `--dangerously-skip-permissions`. The very first such launch on a fresh
 * config dir refuses to start until the one-time disclaimer has been accepted:
 * a `--bg` gate exits 1 ("--bg with bypassPermissions requires accepting the
 * disclaimer first") rather than launching. A managed account created by the app
 * has never been through that interactive accept, so an autonomous board-driven
 * run would stall on its first owner gate with no person to answer.
 *
 * Claude Code records the acceptance as `skipDangerousModePermissionPrompt: true`
 * in `<configDir>/settings.json`, so we write it ourselves. This is a read →
 * merge → write that preserves the hooks and any other keys already there, and
 * is idempotent: when the flag is already set it makes no write at all.
 *
 * Scoped deliberately to callers that are about to run a `bypass` gate; it is
 * not set for every managed account, so an account a person later uses
 * interactively still gets the safety prompt.
 *
 * Returns true when the flag is set on disk afterwards (whether we wrote it or
 * it was already there), false only when the write failed.
 */
export function ensureDangerousModeAccepted(configDir?: string): boolean {
  const settings = readClaudeSettings(configDir);
  if (settings.skipDangerousModePermissionPrompt === true) {
    return true; // Already accepted -- no write, so repeated gate launches don't thrash the file.
  }

  settings.skipDangerousModePermissionPrompt = true;
  const wrote = writeClaudeSettings(settings, configDir);
  if (wrote) {
    log.info(`[Claude Settings] Pre-accepted bypass disclaimer for ${configDir ?? '(default)'}`);
  } else {
    log.warn(`[Claude Settings] Failed to pre-accept bypass disclaimer for ${configDir ?? '(default)'}`);
  }
  return wrote;
}

/** Claude Code's per-config-dir state file, holding per-project trust + more. */
export function getClaudeJsonPath(configDir?: string): string {
  return path.join(resolveConfigDir(configDir), '.claude.json');
}

/**
 * Pre-accept the workspace-trust dialog for one folder under a config dir.
 *
 * Distinct from the bypass disclaimer: Claude Code refuses to run in a folder
 * whose trust prompt has not been accepted, and a `--bg` gate in an untrusted
 * folder exits 1 ("Workspace not trusted"). Each cross-repo run cuts FRESH
 * worktrees, which are untrusted by default, so an autonomous run parks at its
 * first owner gate. Claude Code records trust in `.claude.json` as
 * `projects[<absolute cwd>].hasTrustDialogAccepted: true`, so we set it ourselves
 * for the gate's cwd before launch.
 *
 * `.claude.json` is Claude Code's own large state file (project history, OAuth,
 * machine id), so this is a careful read -> merge -> atomic write that preserves
 * every other key, and it REFUSES to write over a file it could not parse rather
 * than clobber real state. Idempotent: no write when the folder is already
 * trusted.
 */
export function ensureWorkspaceTrusted(configDir: string | undefined, cwd: string): boolean {
  const file = getClaudeJsonPath(configDir);

  // Claude Code stores and looks up workspace trust by the FORWARD-SLASH form of
  // the path (it normalizes internally), even on Windows. Seeding the raw
  // backslash path leaves `--bg` still reporting the folder untrusted -- an exact
  // key mismatch -- so normalize here. Confirmed empirically: a forward-slash key
  // makes `claude --bg` launch in a fresh worktree; the backslash key does not.
  const key = cwd.replace(/\\/g, '/');

  let state: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      // A real, multi-KB state file we cannot parse must never be overwritten.
      log.warn(`[Claude Settings] .claude.json unparseable; not seeding trust for ${cwd}:`, err);
      return false;
    }
  }

  const projects = state.projects && typeof state.projects === 'object'
    ? (state.projects as Record<string, Record<string, unknown>>)
    : {};
  const existing = projects[key];
  if (existing?.hasTrustDialogAccepted === true) {
    return true; // Already trusted -- no write.
  }

  projects[key] = { ...(existing ?? {}), hasTrustDialogAccepted: true };
  state.projects = projects;

  try {
    const tmp = `${file}.bodhilander.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    log.info(`[Claude Settings] Trusted workspace ${cwd} for ${configDir ?? '(default)'}`);
    return true;
  } catch (err) {
    log.error(`[Claude Settings] Failed to write .claude.json trust for ${cwd}:`, err);
    return false;
  }
}
