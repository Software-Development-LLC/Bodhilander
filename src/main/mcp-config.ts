/**
 * MCP Server Auto-Configuration
 *
 * Automatically registers the ClaudeLander Memory MCP server with Claude Code
 * so users don't need to manually configure it.
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

interface ClaudeSettings {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

const MCP_SERVER_NAME = 'claudelander-memory';

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
 * Get the path to Claude Code's settings file
 */
function getClaudeSettingsPath(): string {
  const homeDir = os.homedir();

  // Claude Code stores settings in ~/.claude/settings.json on all platforms
  return path.join(homeDir, '.claude', 'settings.json');
}

/**
 * Read Claude Code settings, creating default if doesn't exist
 */
function readClaudeSettings(): ClaudeSettings {
  const settingsPath = getClaudeSettingsPath();

  try {
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    log.warn('[MCP Config] Failed to read Claude settings:', err);
  }

  return {};
}

/**
 * Write Claude Code settings
 */
function writeClaudeSettings(settings: ClaudeSettings): boolean {
  const settingsPath = getClaudeSettingsPath();
  const settingsDir = path.dirname(settingsPath);

  try {
    // Ensure .claude directory exists
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch (err) {
    log.error('[MCP Config] Failed to write Claude settings:', err);
    return false;
  }
}

/**
 * Check if our MCP server is already configured with the correct path
 */
function isServerConfigured(settings: ClaudeSettings, expectedPath: string): boolean {
  const serverConfig = settings.mcpServers?.[MCP_SERVER_NAME];
  if (!serverConfig) return false;

  // Check if the path matches
  const configuredPath = serverConfig.args?.[0];
  return configuredPath === expectedPath;
}

/**
 * Register the ClaudeLander Memory MCP server with Claude Code
 * Returns true if configuration was added/updated, false if already configured
 */
export function registerMcpServer(): { success: boolean; action: 'added' | 'updated' | 'unchanged' | 'error'; path?: string; error?: string } {
  try {
    const mcpServerPath = getMcpServerPath();

    // Verify the MCP server exists
    if (!fs.existsSync(mcpServerPath)) {
      log.warn('[MCP Config] MCP server not found at:', mcpServerPath);
      return { success: false, action: 'error', error: `MCP server not found at ${mcpServerPath}` };
    }

    const settings = readClaudeSettings();

    // Check if already configured correctly
    if (isServerConfigured(settings, mcpServerPath)) {
      log.info('[MCP Config] MCP server already configured correctly');
      return { success: true, action: 'unchanged', path: mcpServerPath };
    }

    // Determine if we're adding or updating
    const action = settings.mcpServers?.[MCP_SERVER_NAME] ? 'updated' : 'added';

    // Add or update the MCP server configuration
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }

    settings.mcpServers[MCP_SERVER_NAME] = {
      command: 'node',
      args: [mcpServerPath],
    };

    // Write the updated settings
    if (writeClaudeSettings(settings)) {
      log.info(`[MCP Config] MCP server ${action} successfully:`, mcpServerPath);
      return { success: true, action, path: mcpServerPath };
    } else {
      return { success: false, action: 'error', error: 'Failed to write settings file' };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('[MCP Config] Error registering MCP server:', errorMsg);
    return { success: false, action: 'error', error: errorMsg };
  }
}

/**
 * Unregister the ClaudeLander Memory MCP server from Claude Code
 */
export function unregisterMcpServer(): boolean {
  try {
    const settings = readClaudeSettings();

    if (settings.mcpServers?.[MCP_SERVER_NAME]) {
      delete settings.mcpServers[MCP_SERVER_NAME];

      // Clean up empty mcpServers object
      if (Object.keys(settings.mcpServers).length === 0) {
        delete settings.mcpServers;
      }

      if (writeClaudeSettings(settings)) {
        log.info('[MCP Config] MCP server unregistered successfully');
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
 * Get the current MCP server configuration status
 */
export function getMcpServerStatus(): { configured: boolean; path?: string; expectedPath?: string } {
  try {
    const expectedPath = getMcpServerPath();
    const settings = readClaudeSettings();
    const serverConfig = settings.mcpServers?.[MCP_SERVER_NAME];

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
