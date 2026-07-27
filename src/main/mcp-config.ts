/**
 * Hooks Auto-Configuration (+ legacy MCP cleanup)
 *
 * Automatically registers the Bodhilander hook script with Claude Code so users
 * don't need to configure it manually. The hook is what writes the
 * tool_use/turn_complete/error/notification session events that back the
 * analytics panel, so it is installed into the global ~/.claude and into every
 * isolated account config dir.
 *
 * The former "bodhilander-memory" MCP server no longer ships. Its registration
 * code is gone; all that remains here is `cleanupLegacyMcpServer()`, which rips
 * the now-dangling entry back out of users' Claude configs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import log from 'electron-log';
import { getPreference, setPreference } from './repositories/preferences';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookConfig {
  matcher: string;
  hooks: HookCommand[];
}

interface ClaudeMcpConfig {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

interface ClaudeSettingsConfig {
  hooks?: {
    PreToolUse?: HookConfig[];
    PostToolUse?: HookConfig[];
    Stop?: HookConfig[];
    Notification?: HookConfig[];
    [key: string]: HookConfig[] | undefined;
  };
  [key: string]: unknown;
}

/**
 * Name of the MCP server this app used to register. The server itself is gone;
 * the constant survives only so the cleanup sweep can find and delete stale
 * entries from configs written by older versions.
 */
const MCP_SERVER_NAME = 'bodhilander-memory';

/**
 * Preference key marking that the legacy MCP entry has been swept.
 *
 * Stored in the app's existing SQLite `preferences` table (same mechanism as
 * `legacyCodeSearchCleanupDone` in database.ts) rather than a new marker file:
 * the app has no electron-store, and a preference travels with the rest of the
 * user's state instead of leaving a stray dotfile behind. One-shot by design —
 * without the marker we would re-delete the entry on every launch and fight a
 * user who deliberately re-added an MCP server under that name.
 */
const LEGACY_MCP_CLEANUP_PREF = 'legacyMemoryMcpCleanupDone';

// Substrings identifying hook commands this app (or its prior incarnation as
// "ClaudeLander") has registered. Used for cleanup during upgrade/reinstall.
// Case-insensitive match.
const OUR_HOOK_IDENTIFIERS = ['bodhilander', 'claudelander'];

/**
 * Whether a hook command string was registered by this app (or its prior
 * "ClaudeLander" incarnation). Used to identify entries we own during cleanup.
 */
function isOurHookCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return OUR_HOOK_IDENTIFIERS.some(id => lower.includes(id));
}

/**
 * Remove Bodhilander/legacy-ClaudeLander hook entries from settings across ALL
 * hook types (not just PostToolUse/Stop — older versions may have written
 * PreToolUse or Notification hooks). Mutates `settings` in place.
 *
 * If `keepPath` is provided, commands whose string contains that path are
 * preserved (they are the currently-valid registration). This makes cleanup
 * idempotent with `registerHooks`: calling with the current hookScriptPath
 * only removes truly stale entries.
 *
 * Returns true if any entries were removed.
 */
function purgeOurHooks(settings: ClaudeSettingsConfig, keepPath?: string): boolean {
  if (!settings.hooks) return false;

  const shouldRemove = (h: HookCommand): boolean => {
    if (!isOurHookCommand(h.command)) return false;
    if (keepPath && h.command.includes(keepPath)) return false;
    return true;
  };

  let modified = false;

  for (const hookType of Object.keys(settings.hooks)) {
    const configs = settings.hooks[hookType];
    if (!configs) continue;

    const newConfigs: HookConfig[] = [];
    for (const config of configs) {
      const keptHooks = config.hooks.filter(h => !shouldRemove(h));
      if (keptHooks.length === config.hooks.length) {
        newConfigs.push(config);
      } else {
        modified = true;
        if (keptHooks.length > 0) {
          newConfigs.push({ ...config, hooks: keptHooks });
        }
      }
    }

    if (newConfigs.length > 0) {
      settings.hooks[hookType] = newConfigs;
    } else {
      delete settings.hooks[hookType];
    }
  }

  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  return modified;
}

/**
 * Resolve the `.claude` config directory for a given account (BDHLNDR-31).
 * When configDir is omitted, defaults to the user's global ~/.claude.
 * Pass an account's isolated configDir to target that account's sandbox
 * instead of the global one.
 */
function resolveConfigDir(configDir?: string): string {
  return configDir ?? path.join(os.homedir(), '.claude');
}

/**
 * Get the path to Claude Code's MCP config file for the given config dir.
 * Claude Code keeps MCP servers in a `.claude.json` that sits alongside the
 * `.claude/` directory (not inside it). For the default case this is
 * `~/.claude.json`; for an isolated account it's `<parent>/.claude.json`
 * next to the account's `.claude/`.
 */
function getClaudeConfigPath(configDir?: string): string {
  const claudeDir = resolveConfigDir(configDir);
  return path.join(path.dirname(claudeDir), '.claude.json');
}

/**
 * Read Claude Code MCP config, returning empty object if the file doesn't exist
 */
function readClaudeMcpConfig(configDir?: string): ClaudeMcpConfig {
  const configPath = getClaudeConfigPath(configDir);

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    log.warn('[MCP Config] Failed to read Claude MCP config:', err);
  }

  return {};
}

/**
 * Write Claude Code MCP config
 */
function writeClaudeMcpConfig(config: ClaudeMcpConfig, configDir?: string): boolean {
  const configPath = getClaudeConfigPath(configDir);

  try {
    // Ensure parent dir exists (account root may not exist until first write).
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    // Write via temp file + rename so the write is atomic. This is not our
    // file: ~/.claude.json is Claude Code's own state (project history, OAuth
    // account, machine id, migration flags) and routinely tens of KB. A
    // truncating in-place write that is interrupted — crash, power loss, or
    // Claude Code writing concurrently — would leave the user with a corrupt
    // config and no way back. rename() within the same directory is atomic on
    // both POSIX and NTFS.
    const tmpPath = `${configPath}.bodhilander.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch (err) {
    log.error('[MCP Config] Failed to write Claude MCP config:', err);
    return false;
  }
}

/**
 * Get path to Claude Code settings file. Hooks are configured here.
 * Default: `~/.claude/settings.json`. With a configDir passed: `<configDir>/settings.json`.
 */
function getClaudeSettingsPath(configDir?: string): string {
  return path.join(resolveConfigDir(configDir), 'settings.json');
}

/**
 * Read Claude Code settings for the given config dir.
 * Default target: `~/.claude/settings.json`.
 */
function readClaudeSettings(configDir?: string): ClaudeSettingsConfig {
  const settingsPath = getClaudeSettingsPath(configDir);

  try {
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    log.warn('[Hooks Config] Failed to read Claude settings:', err);
  }

  return {};
}

/**
 * Write Claude Code settings
 */
function writeClaudeSettings(settings: ClaudeSettingsConfig, configDir?: string): boolean {
  const settingsPath = getClaudeSettingsPath(configDir);

  try {
    // Ensure the target .claude directory exists
    const claudeDir = path.dirname(settingsPath);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Temp file + atomic rename, same as writeClaudeMcpConfig. settings.json is
    // the user's own Claude Code configuration (permissions, model, statusLine,
    // their own hooks) and we rewrite it on every launch, so a torn write from
    // a crash or power loss would cost them real state. rename() within a
    // directory is atomic on both POSIX and NTFS.
    const tmpPath = `${settingsPath}.bodhilander.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmpPath, settingsPath);
    return true;
  } catch (err) {
    log.error('[Hooks Config] Failed to write Claude settings:', err);
    return false;
  }
}

/**
 * Get the path to the hook handler script
 */
function getHookScriptPath(): string {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'dist', 'hooks', 'bodhilander-hook.js');
  }

  const resourcesPath = process.resourcesPath;

  // Check for unpacked location first
  const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked', 'dist', 'hooks', 'bodhilander-hook.js');
  if (fs.existsSync(unpackedPath)) {
    return unpackedPath;
  }

  return path.join(resourcesPath, 'app', 'dist', 'hooks', 'bodhilander-hook.js');
}

/**
 * Check if hooks pointing at the current hook script are already configured.
 * Matches on the exact hookScriptPath so that an install-location change
 * (e.g. version upgrade to a new unpacked path) triggers a re-register.
 */
/**
 * The hook entries we install — the single source of truth for both "are they
 * already correct?" and what gets written. Keeping one definition is what lets
 * registration CONVERGE: change a matcher here and existing installs get
 * rewritten on next launch instead of keeping whatever they were first given.
 */
function desiredHookConfigs(hookScriptPath: string): { postToolUse: HookConfig; stop: HookConfig } {
  return {
    // Match ALL tools. The old 'Bash' matcher was a memory-feature artifact —
    // it existed only to sniff `git commit` invocations for auto-saved
    // "decision" memories. Analytics wants every tool call, so restricting to
    // Bash just undercounted everything. Claude Code's hook docs give "*", ""
    // and an omitted matcher as equivalent match-all values.
    postToolUse: {
      matcher: '*',
      hooks: [{ type: 'command', command: `node "${hookScriptPath}" PostToolUse` }],
    },
    stop: {
      matcher: '',
      hooks: [{ type: 'command', command: `node "${hookScriptPath}" Stop` }],
    },
  };
}

function hasHookConfig(configs: HookConfig[] | undefined, desired: HookConfig): boolean {
  if (!configs) return false;
  return configs.some(
    config =>
      config.matcher === desired.matcher &&
      config.hooks.some(h => h.command === desired.hooks[0].command),
  );
}

/**
 * True only when BOTH our entries are present with the exact matcher and
 * command we want.
 *
 * Deliberately an AND, and deliberately compares the matcher. The previous
 * version OR'd the two hook types and only checked that the path appeared
 * somewhere, which meant (a) a settings file carrying just one of the two
 * reported "configured" and the missing one was never added, and (b) an entry
 * with a stale matcher was accepted forever, so changing a matcher here would
 * only ever reach fresh installs.
 */
function areHooksConfigured(settings: ClaudeSettingsConfig, hookScriptPath: string): boolean {
  const hooks = settings.hooks;
  if (!hooks) return false;

  const desired = desiredHookConfigs(hookScriptPath);
  return hasHookConfig(hooks.PostToolUse, desired.postToolUse) && hasHookConfig(hooks.Stop, desired.stop);
}

/**
 * Register Bodhilander hooks with Claude Code.
 * Adds hooks for PostToolUse (git commits) and Stop (session summaries).
 *
 * Stale entries from prior installs (including the former "ClaudeLander"
 * name) are purged from ALL hook types before any file-existence check, so
 * users of renamed/removed installs aren't left with broken hook commands.
 */
export function registerHooks(configDir?: string): { success: boolean; action: 'added' | 'updated' | 'unchanged' | 'error'; error?: string } {
  try {
    const hookScriptPath = getHookScriptPath();
    const settings = readClaudeSettings(configDir);

    // Purge stale Bodhilander/ClaudeLander entries FIRST — do this before any
    // early return, so users whose new hook script is missing still get their
    // broken stale entries cleaned up. Passing hookScriptPath keeps current
    // valid entries in place so repeated startups don't thrash settings.
    const purged = purgeOurHooks(settings, hookScriptPath);
    if (purged) {
      writeClaudeSettings(settings, configDir);
      log.info(`[Hooks Config] Purged stale Bodhilander/ClaudeLander hook entries from ${configDir ?? '(default)'}`);
    }

    // Verify the hook script exists before attempting to register new entries
    if (!fs.existsSync(hookScriptPath)) {
      log.warn('[Hooks Config] Hook script not found at:', hookScriptPath);
      return { success: false, action: 'error', error: `Hook script not found at ${hookScriptPath}` };
    }

    // Check if current (correct-path) entries are already configured
    if (areHooksConfigured(settings, hookScriptPath)) {
      log.info(`[Hooks Config] Hooks already configured for ${configDir ?? '(default)'}`);
      return { success: true, action: 'unchanged' };
    }

    // Determine if we're adding or updating
    const action = settings.hooks ? 'updated' : 'added';

    const { postToolUse: postToolUseHook, stop: stopHook } = desiredHookConfigs(hookScriptPath);

    // Drop any of OUR entries still present before appending the desired ones.
    // The earlier purge kept current-path entries to avoid thrashing settings
    // on every launch; here we know they are wrong in some way (wrong matcher,
    // or one of the pair missing), so a stale-but-same-path entry has to go —
    // otherwise upgrading users would end up with both the old Bash-only entry
    // and the new match-all one, firing the hook twice on every Bash call.
    purgeOurHooks(settings);

    // Initialise AFTER the purge, not before: purgeOurHooks deletes emptied
    // hook types and drops settings.hooks entirely when nothing is left, so
    // initialising first would hand us an object the purge then removed.
    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Append to any existing (non-ours) entries on these hook types.
    settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse ?? []), postToolUseHook];
    settings.hooks.Stop = [...(settings.hooks.Stop ?? []), stopHook];

    // Write the updated settings
    if (writeClaudeSettings(settings, configDir)) {
      log.info(`[Hooks Config] Hooks ${action} successfully for ${configDir ?? '(default)'}`);
      return { success: true, action };
    } else {
      return { success: false, action: 'error', error: 'Failed to write settings file' };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('[Hooks Config] Error registering hooks:', errorMsg);
    return { success: false, action: 'error', error: errorMsg };
  }
}

/**
 * Remove the legacy `bodhilander-memory` MCP entry from one Claude config.
 * Returns true if an entry was found and removed.
 */
export function unregisterMcpServer(configDir?: string): boolean {
  try {
    const config = readClaudeMcpConfig(configDir);

    if (config.mcpServers?.[MCP_SERVER_NAME]) {
      delete config.mcpServers[MCP_SERVER_NAME];

      // Clean up empty mcpServers object
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }

      if (writeClaudeMcpConfig(config, configDir)) {
        log.info(`[MCP Config] MCP server unregistered successfully for ${configDir ?? '(default)'}`);
        return true;
      }
    }

    return false;
  } catch (err) {
    log.error('[MCP Config] Error unregistering MCP server:', err);
    return false;
  }
}

/**
 * Every account config dir under `<userData>/claude-accounts/<id>/.claude`
 * (BDHLNDR-31), read straight off disk rather than from the accounts table so
 * that dirs left behind by deleted accounts are swept too.
 */
/**
 * Account config dirs to sweep, or null if we could not find out.
 *
 * The null case matters: returning [] on failure is indistinguishable from
 * "this install has no accounts", which would let the one-shot cleanup marker
 * latch after sweeping only the global config. Every per-account .claude.json
 * would then keep its dangling entry forever — exactly what the sweep exists
 * to prevent. A transient EPERM (AV scanner mid-startup on Windows) or EBUSY
 * (roaming profile mount) on the single launch the sweep runs is enough.
 */
function listAccountConfigDirs(): string[] | null {
  try {
    const accountsRoot = path.join(app.getPath('userData'), 'claude-accounts');
    if (!fs.existsSync(accountsRoot)) return [];

    return fs
      .readdirSync(accountsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(accountsRoot, entry.name, '.claude'));
  } catch (err) {
    log.warn('[MCP Config] Failed to enumerate account config dirs:', err);
    return null;
  }
}

/**
 * One-shot uninstall of the removed memory MCP server (see MCP_SERVER_NAME).
 *
 * The server binary no longer ships, so any surviving registration points at a
 * missing script and makes Claude Code report a broken MCP server on every
 * launch. This sweeps the entry out of the global `~/.claude.json` AND out of
 * each `<userData>/claude-accounts/<id>/.claude.json`. Note those files are
 * SIBLINGS of the corresponding `.claude/` directories, not inside them —
 * getClaudeConfigPath() takes the dirname, so passing an account's `.claude`
 * dir resolves to the right place.
 *
 * Runs at most once per install: after a successful pass the
 * LEGACY_MCP_CLEANUP_PREF marker is set, so a user who later re-adds an MCP
 * server under that name keeps it. Hooks are untouched — the hook script is
 * still shipped and still registered.
 */
export function cleanupLegacyMcpServer(): void {
  try {
    if (getPreference(LEGACY_MCP_CLEANUP_PREF) === 'true') return;

    let removed = 0;
    let failed = 0;

    // A null enumeration means we could not tell whether accounts exist, so
    // count it as a failure rather than sweeping the global config and
    // latching as if we were done.
    const accountDirs = listAccountConfigDirs();
    if (accountDirs === null) failed++;

    for (const configDir of [undefined, ...(accountDirs ?? [])]) {
      // Pre-check so a `false` from unregisterMcpServer unambiguously means
      // "the write failed", not "there was nothing to remove".
      if (!readClaudeMcpConfig(configDir).mcpServers?.[MCP_SERVER_NAME]) continue;

      if (unregisterMcpServer(configDir)) removed++;
      else failed++;
    }

    if (removed > 0) {
      log.info(`[MCP Config] Removed legacy '${MCP_SERVER_NAME}' entry from ${removed} Claude config(s)`);
    }

    // Only latch the marker once every config came out clean — a config that
    // couldn't be written (permissions, read-only volume) gets another try on
    // the next launch. Marking done when nothing was found is correct: an
    // absent entry means there is nothing left to sweep.
    if (failed === 0) {
      setPreference(LEGACY_MCP_CLEANUP_PREF, 'true');
    } else {
      log.warn(`[MCP Config] Legacy MCP cleanup incomplete for ${failed} config(s); will retry next launch`);
    }
  } catch (err) {
    // Leave the marker unset so the sweep retries next launch; it's idempotent.
    log.warn('[MCP Config] Legacy MCP server cleanup failed:', err);
  }
}

/*
 * There is deliberately no unregisterHooks() any more.
 *
 * It existed to tear out every Bodhilander hook, and it called
 * purgeOurHooks(settings) with no keepPath — which now matches the analytics
 * hook we intentionally keep installed (it is the only writer of the
 * tool_use / turn_complete session_events that AnalyticsPanel and
 * SessionStatsBadge read). It had zero callers, so it was a loaded gun aimed at
 * a live feature: one plausible "clean up on uninstall" wiring would have
 * silently disabled analytics for every user.
 *
 * If a real uninstall path is ever needed, write it deliberately and decide
 * then whether the analytics hook should go with it — do not resurrect a
 * blanket purge.
 */

/**
 * Get the current hooks configuration status
 */
export function getHooksStatus(configDir?: string): { configured: boolean; hookScriptPath?: string } {
  try {
    const hookScriptPath = getHookScriptPath();
    const settings = readClaudeSettings(configDir);
    const configured = areHooksConfigured(settings, hookScriptPath);

    return { configured, hookScriptPath };
  } catch (err) {
    log.error('[Hooks Config] Error getting hooks status:', err);
    return { configured: false };
  }
}
