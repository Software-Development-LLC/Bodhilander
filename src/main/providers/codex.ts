import { ProviderDefinition, ProviderLaunchConfig, ProviderCommand } from './types';

/**
 * OpenAI Codex CLI (`codex`). Auth is handled by the CLI itself
 * (`codex login` / OPENAI_API_KEY). Codex manages its own conversation ids
 * (`codex resume` picker) and offers no flag to assign one up front, so
 * Bodhilander's stored-UUID resume machinery is disabled.
 */
export const codexProvider: ProviderDefinition = {
  id: 'codex',
  name: 'Codex (OpenAI)',
  command: 'codex',
  capabilities: {
    resume: false,
    hooks: false,
    systemPrompt: false,
    accounts: false,
  },

  buildCommand(config: ProviderLaunchConfig): ProviderCommand {
    return {
      command: 'codex',
      args: [],
      env: {
        ...process.env,
        BODHILANDER_SESSION_ID: config.sessionId,
        BODHILANDER_SOCKET: config.socketPath,
      },
    };
  },
};
