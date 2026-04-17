/**
 * MCP Server and Hooks Auto-Configuration
 *
 * Automatically registers the Bodhilander Memory MCP server and hooks with Claude Code
 * so users don't need to manually configure them.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import log from 'electron-log';

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

const MCP_SERVER_NAME = 'bodhilander-memory';

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
 * Get the path to the MCP server script
 */
function getMcpServerPath(): string {
  // In development, use the dist folder relative to the project
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'dist', 'mcp-server', 'index.js');
  }

  // In production, the MCP server is in the resources folder
  // For asar-packed apps, it's in app.asar/dist/mcp-server
  // But we need it outside asar for Node to run it directly
  const resourcesPath = process.resourcesPath;

  // Check for unpacked location first (if we configure electron-builder to unpack it)
  const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked', 'dist', 'mcp-server', 'index.js');
  if (fs.existsSync(unpackedPath)) {
    return unpackedPath;
  }

  // Fall back to regular path (may not work if inside asar)
  return path.join(resourcesPath, 'app', 'dist', 'mcp-server', 'index.js');
}

/**
 * Resolve the `.claude` config directory for a given account (BDHLNDR-31).
 * When configDir is omitted, defaults to the user's global ~/.claude.
 * Pass an account's isolated configDir to register MCP/hooks into that
 * account's sandbox instead of the global one.
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
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
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

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
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
 * Check if our MCP server is already configured with the correct path
 */
function isServerConfigured(config: ClaudeMcpConfig, expectedPath: string): boolean {
  const serverConfig = config.mcpServers?.[MCP_SERVER_NAME];
  if (!serverConfig) return false;

  // Check if the path matches
  const configuredPath = serverConfig.args?.[0];
  return configuredPath === expectedPath;
}

/**
 * Check if hooks pointing at the current hook script are already configured.
 * Matches on the exact hookScriptPath so that an install-location change
 * (e.g. version upgrade to a new unpacked path) triggers a re-register.
 */
function areHooksConfigured(settings: ClaudeSettingsConfig, hookScriptPath: string): boolean {
  const hooks = settings.hooks;
  if (!hooks) return false;

  const checkHookType = (hookConfigs: HookConfig[] | undefined): boolean => {
    if (!hookConfigs) return false;
    return hookConfigs.some(config =>
      config.hooks.some(h => h.command.includes(hookScriptPath))
    );
  };

  return checkHookType(hooks.PostToolUse) || checkHookType(hooks.Stop);
}

/**
 * Register the Bodhilander Memory MCP server with Claude Code
 * Returns true if configuration was added/updated, false if already configured
 */
export function registerMcpServer(configDir?: string): { success: boolean; action: 'added' | 'updated' | 'unchanged' | 'error'; path?: string; error?: string } {
  try {
    const mcpServerPath = getMcpServerPath();

    // Verify the MCP server exists
    if (!fs.existsSync(mcpServerPath)) {
      log.warn('[MCP Config] MCP server not found at:', mcpServerPath);
      return { success: false, action: 'error', error: `MCP server not found at ${mcpServerPath}` };
    }

    const config = readClaudeMcpConfig(configDir);

    // Check if already configured correctly
    if (isServerConfigured(config, mcpServerPath)) {
      log.info(`[MCP Config] MCP server already configured correctly for ${configDir ?? '(default)'}`);
      return { success: true, action: 'unchanged', path: mcpServerPath };
    }

    // Determine if we're adding or updating
    const action = config.mcpServers?.[MCP_SERVER_NAME] ? 'updated' : 'added';

    // Add or update the MCP server configuration
    if (!config.mcpServers) {
      config.mcpServers = {};
    }

    config.mcpServers[MCP_SERVER_NAME] = {
      command: 'node',
      args: [mcpServerPath],
    };

    // Write the updated config
    if (writeClaudeMcpConfig(config, configDir)) {
      log.info(`[MCP Config] MCP server ${action} successfully for ${configDir ?? '(default)'}:`, mcpServerPath);
      return { success: true, action, path: mcpServerPath };
    } else {
      return { success: false, action: 'error', error: 'Failed to write config file' };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('[MCP Config] Error registering MCP server:', errorMsg);
    return { success: false, action: 'error', error: errorMsg };
  }
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

    // Initialize hooks object if needed
    if (!settings.hooks) {
      settings.hooks = {};
    }

    // PostToolUse hook for Bash (captures git commits)
    const postToolUseHook: HookConfig = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `node "${hookScriptPath}" PostToolUse` }],
    };

    // Stop hook (captures session summaries after significant work)
    const stopHook: HookConfig = {
      matcher: '',  // Match all stops
      hooks: [{ type: 'command', command: `node "${hookScriptPath}" Stop` }],
    };

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
 * Unregister the Bodhilander Memory MCP server from Claude Code
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
 * Unregister Bodhilander hooks from Claude Code (including any legacy
 * ClaudeLander entries from before the app rename).
 */
export function unregisterHooks(configDir?: string): boolean {
  try {
    const settings = readClaudeSettings(configDir);

    if (!purgeOurHooks(settings)) return false;

    if (writeClaudeSettings(settings, configDir)) {
      log.info(`[Hooks Config] Hooks unregistered successfully for ${configDir ?? '(default)'}`);
      return true;
    }

    return false;
  } catch (err) {
    log.error('[Hooks Config] Error unregistering hooks:', err);
    return false;
  }
}

/**
 * Get the current MCP server configuration status
 */
export function getMcpServerStatus(configDir?: string): { configured: boolean; path?: string; expectedPath?: string } {
  try {
    const expectedPath = getMcpServerPath();
    const config = readClaudeMcpConfig(configDir);
    const serverConfig = config.mcpServers?.[MCP_SERVER_NAME];

    if (!serverConfig) {
      return { configured: false, expectedPath };
    }

    return {
      configured: true,
      path: serverConfig.args?.[0],
      expectedPath,
    };
  } catch (err) {
    log.error('[MCP Config] Error getting MCP server status:', err);
    return { configured: false };
  }
}

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
