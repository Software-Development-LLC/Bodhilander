import { ProviderDefinition, ProviderLaunchConfig, ProviderCommand } from './types';

/**
 * Google Gemini CLI (`gemini`). Auth is handled by the CLI itself
 * (Google login / GEMINI_API_KEY). Conversation resume is interactive inside
 * the TUI rather than flag-addressable, so stored-UUID resume is disabled.
 */
export const geminiProvider: ProviderDefinition = {
  id: 'gemini',
  name: 'Gemini CLI (Google)',
  command: 'gemini',
  capabilities: {
    resume: false,
    hooks: false,
    systemPrompt: false,
    accounts: false,
  },

  buildCommand(config: ProviderLaunchConfig): ProviderCommand {
    return {
      command: 'gemini',
      args: [],
      env: {
        ...process.env,
        BODHILANDER_SESSION_ID: config.sessionId,
        BODHILANDER_SOCKET: config.socketPath,
      },
    };
  },
};
