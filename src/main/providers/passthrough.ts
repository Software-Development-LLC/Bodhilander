import { ProviderDefinition, ProviderLaunchConfig } from './types';

/**
 * Env vars every agent session exports so Bodhilander tooling (hook script,
 * future integrations) can identify the session and reach the state socket.
 * This is the contract src/hooks/bodhilander-hook.ts reads — change it here,
 * not per provider.
 */
export function baseSessionEnv(config: ProviderLaunchConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BODHILANDER_SESSION_ID: config.sessionId,
    BODHILANDER_SOCKET: config.socketPath,
  };
}

/**
 * A provider whose CLI is launched bare: no resume/session flags, no hooks,
 * no system-prompt injection, no account isolation. Auth and conversation
 * management stay entirely inside the CLI itself.
 */
export function passthroughProvider(
  opts: Pick<ProviderDefinition, 'id' | 'name' | 'command' | 'setup' | 'arena' | 'apiKey'>
): ProviderDefinition {
  return {
    ...opts,
    capabilities: {
      resume: false,
      hooks: false,
      systemPrompt: false,
      accounts: false,
    },
    buildCommand: (config) => ({
      command: opts.command,
      args: [],
      env: baseSessionEnv(config),
    }),
  };
}
