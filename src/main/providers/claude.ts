import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { ProviderDefinition, ProviderLaunchConfig, ProviderCommand } from './types';
import { baseSessionEnv } from './passthrough';
import { claudeParser as claudeArenaParser } from '../arena/parsers';

/** Env var Claude Code reads its isolated config dir from (BDHLNDR-31). */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Claude Code TUI prompts that signal "waiting for user input" — selection
 * menus and the permission dialog. Generic conversational patterns live in
 * the pty state detector; these are specific to Claude Code's rendering.
 */
const CLAUDE_WAITING_PATTERNS = [
  /Enter to confirm/i,               // Claude confirmation prompt
  /Enter to select/i,                // Claude Code selection menu prompt
  /Tab\/Arrow keys to navigate/i,    // Claude Code selection menu
  /Esc to cancel/i,                  // Claude Code selection menu
  /Allow.*Deny/s,                    // Claude permission dialog
  /Type something/i,                 // Claude Code "Type something" option
  />\s*\d+\./,                       // Selected numbered option (> 1.)
] as const;

export const claudeProvider: ProviderDefinition = {
  id: 'claude',
  name: 'Claude Code',
  command: 'claude',
  capabilities: {
    resume: true,
    hooks: true,
    systemPrompt: true,
    accounts: true,
  },
  systemPromptFlag: '--append-system-prompt',
  waitingPatterns: CLAUDE_WAITING_PATTERNS,
  apiKey: {
    envVar: 'ANTHROPIC_API_KEY',
    test: {
      url: 'https://api.anthropic.com/v1/models',
      headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    },
  },
  arena: {
    // No --max-turns cap: folder-scoped arena questions need the agentic
    // loop (reading files), and hitting the cap makes the CLI exit 1 with
    // result subtype error_max_turns even after streaming a full answer.
    // Runaway runs are already bounded by the engine's contestant timeout.
    // stream-json requires --verbose. Verified live: the result event
    // reports usage, total_cost_usd, ttft_ms. --session-id names the
    // session upfront so follow-up rounds can --resume it (headless resume
    // keeps the same id — verified live).
    buildCommand: (promptRef, sessionRef) =>
      `claude -p ${promptRef} --output-format stream-json --verbose --session-id ${sessionRef}`,
    buildResumeCommand: (promptRef, sessionRef) =>
      `claude -p ${promptRef} --output-format stream-json --verbose --resume ${sessionRef}`,
    createParser: claudeArenaParser,
  },
  setup: {
    installHint: 'npm install -g @anthropic-ai/claude-code',
    // --force so re-running repairs broken installs (missing platform
    // optionalDependencies after an interrupted install or Rosetta npm).
    installCommand: 'npm install -g --force @anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    loginHint: 'Run `claude` and complete /login in the browser',
  },

  buildCommand(config: ProviderLaunchConfig): ProviderCommand {
    const hookScriptPath = getHookScriptPath();

    // Ensure hook script exists and is executable
    ensureHookScript(hookScriptPath);

    const env: NodeJS.ProcessEnv = {
      ...baseSessionEnv(config),
      // Point Claude to use our hook
      CLAUDE_HOOKS_DIR: path.dirname(hookScriptPath),
      // Enable experimental MCP CLI features
      ENABLE_EXPERIMENTAL_MCP_CLI: 'true',
    };

    if (config.configDir) {
      env[CLAUDE_CONFIG_DIR_ENV] = config.configDir;
    }

    // Build args for the Claude session UUID (BDHLNDR-9).
    // UUIDs are alphanumeric + hyphens, so they are safe to inline into shell
    // command strings without escaping.
    const args: string[] = [];
    if (config.agentSession) {
      const flag = config.agentSession.mode === 'resume' ? '--resume' : '--session-id';
      args.push(flag, config.agentSession.id);
    }

    return {
      command: 'claude',
      args,
      env,
    };
  },
};

function getHookScriptPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'hooks', 'bodhilander-hook.sh');
}

function ensureHookScript(hookPath: string): void {
  const hookDir = path.dirname(hookPath);

  try {
    if (!fs.existsSync(hookDir)) {
      fs.mkdirSync(hookDir, { recursive: true });
    }

    // Copy hook script from resources or create it
    const hookContent = `#!/bin/bash
# Bodhilander hook script - reports Claude state to main process

SESSION_ID="\${BODHILANDER_SESSION_ID}"
SOCKET_PATH="\${BODHILANDER_SOCKET}"

report_state() {
    local state="$1"
    local event="$2"
    # Escape special JSON characters in SESSION_ID
    local safe_id=$(echo "$SESSION_ID" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
    if [ -n "$SOCKET_PATH" ] && [ -S "$SOCKET_PATH" ]; then
        echo "{\\"sessionId\\":\\"$safe_id\\",\\"state\\":\\"$state\\",\\"event\\":\\"$event\\",\\"timestamp\\":$(date +%s)}" | nc -U "$SOCKET_PATH" 2>/dev/null || true
    fi
}

# Hook handlers based on Claude Code hook events
case "$1" in
    "PreToolUse")
        report_state "waiting" "tool_approval"
        ;;
    "PostToolUse")
        report_state "working" "tool_complete"
        ;;
    "Notification")
        report_state "working" "notification"
        ;;
    "Stop")
        report_state "idle" "stopped"
        ;;
esac

# Always exit 0 to not block Claude
exit 0
`;

    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
  } catch (error) {
    console.error('Failed to write hook script:', error);
    throw new Error(`Failed to set up hook script at ${hookPath}: ${error}`);
  }
}
