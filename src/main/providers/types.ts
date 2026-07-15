import { ArenaStreamParser } from '../arena/parsers';

/**
 * Provider abstraction for agentic CLI sessions (#95).
 *
 * A provider describes how to launch and observe one terminal-native coding
 * agent (Claude Code, OpenAI Codex, Grok Build, ...). Sessions
 * spawn the provider's CLI inside the user's shell via node-pty; nothing here
 * talks to a model API directly.
 */

/**
 * Which CLI flag semantics to use for a stored agent session UUID (BDHLNDR-9).
 * - `new`    → first launch, assign the session's ID up front
 * - `resume` → subsequent launches, restore the prior conversation
 */
export type AgentSessionMode = 'new' | 'resume';

export interface AgentSessionLaunch {
  id: string;
  mode: AgentSessionMode;
}

export interface ProviderCapabilities {
  /**
   * CLI supports assigning/restoring a conversation via flags (e.g. Claude's
   * `--session-id` / `--resume`). When false, sessions always start fresh and
   * the stored-UUID machinery is skipped entirely.
   */
  resume: boolean;
  /** CLI fires lifecycle hooks Bodhilander can wire a state-reporting script into. */
  hooks: boolean;
  /** CLI accepts an appended system prompt flag (memory injection). */
  systemPrompt: boolean;
  /**
   * CLI supports isolated per-account config directories (BDHLNDR-31,
   * Claude's CLAUDE_CONFIG_DIR). Gates account resolution at spawn time.
   */
  accounts: boolean;
}

export interface ProviderLaunchConfig {
  /** Bodhilander session id (DB row id), not the agent's conversation id. */
  sessionId: string;
  projectDir: string;
  /** Unix socket / named pipe the hook script reports state changes to. */
  socketPath: string;
  /** Agent conversation UUID + mode; only passed to resume-capable providers. */
  agentSession?: AgentSessionLaunch;
  /** Isolated config dir for multi-account providers (BDHLNDR-31). */
  configDir?: string;
}

export interface ProviderCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface ProviderDefinition {
  /** Stable id persisted on sessions (e.g. 'claude', 'codex'). */
  id: string;
  /** Human-readable name for pickers and settings. */
  name: string;
  /** CLI binary name — also what installed-CLI detection probes for. */
  command: string;
  capabilities: ProviderCapabilities;
  /**
   * Flag that appends a system prompt (e.g. `--append-system-prompt`). The
   * pty layer interpolates the shell-appropriate env-var reference after it,
   * so the prompt text never needs shell escaping. Required when
   * capabilities.systemPrompt is true.
   */
  systemPromptFlag?: string;
  /**
   * Provider-specific TUI patterns that signal "waiting for user input",
   * merged with the generic pattern set by the pty state detector.
   */
  waitingPatterns?: readonly RegExp[];
  /**
   * Direct-API credential support (#99), for providers whose CLI can
   * authenticate via an API-key env var. Absent = API keys don't apply
   * (e.g. a purely local provider) and the vault treats the provider as
   * not applicable. A stored key is used only when the user explicitly
   * enables it per provider — CLI login/subscription remains the default
   * (issue #100 decision). `test` names a cheap authenticated endpoint
   * for validating a stored key.
   */
  apiKey?: {
    envVar: string;
    test: {
      url: string;
      headers(key: string): Record<string, string>;
    };
  };
  /**
   * Headless invocation for arena mode (#100). promptRef is the
   * shell-appropriate env-var reference for the prompt (e.g.
   * `"$ARENA_PROMPT"`), so the prompt text itself never touches the command
   * string — it travels via the environment, immune to shell injection.
   * Runs under the user's existing CLI login (subscription), never an API key.
   */
  arena: {
    buildCommand(promptRef: string): string;
    createParser(): ArenaStreamParser;
  };
  /** Setup guidance surfaced in Settings → Providers when the CLI is missing (#97). */
  setup: {
    /** Install command or instruction, shown as copyable text. */
    installHint: string;
    /** Official installation/authentication documentation URL. */
    docsUrl: string;
    /** How to authenticate after installing. */
    loginHint: string;
  };
  /** Build the command, args, and env for launching a session. */
  buildCommand(config: ProviderLaunchConfig): ProviderCommand;
}
