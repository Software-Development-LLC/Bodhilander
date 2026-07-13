import { ProviderDefinition, ProviderLaunchConfig, ProviderCommand } from './types';

/**
 * xAI Grok Build (`grok`, per https://docs.x.ai/build/overview). Auth is
 * handled by the CLI itself (`grok-build login` / XAI_API_KEY for headless).
 * No documented session-resume or system-prompt flags as of v0.1.
 */
export const grokProvider: ProviderDefinition = {
  id: 'grok',
  name: 'Grok Build (xAI)',
  command: 'grok',
  capabilities: {
    resume: false,
    hooks: false,
    systemPrompt: false,
    accounts: false,
  },

  buildCommand(config: ProviderLaunchConfig): ProviderCommand {
    return {
      command: 'grok',
      args: [],
      env: {
        ...process.env,
        BODHILANDER_SESSION_ID: config.sessionId,
        BODHILANDER_SOCKET: config.socketPath,
      },
    };
  },
};
