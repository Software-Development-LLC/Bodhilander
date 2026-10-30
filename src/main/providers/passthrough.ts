import { ProviderDefinition, ProviderLaunchConfig } from './types';

/**
 * Env vars every agent session exports so Bodhilander tooling (hook script,
 * future integrations) can identify the session and reach the state socket
 * and the API.
 * This is the contract src/hooks/bodhilander-hook.ts reads — change it here,
 * not per provider.
 */
export function baseSessionEnv(config: ProviderLaunchConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...envWithoutSessionVars(),
    BODHILANDER_SESSION_ID: config.sessionId,
    BODHILANDER_SOCKET: config.socketPath,
  };
  if (config.apiPort) env.BODHILANDER_API_URL = `http://127.0.0.1:${config.apiPort}`;
  return env;
}

/**
 * `process.env` without the session vars. A CLI Bodhilander starts outside a
 * pty must not report hooks as the tab the app itself was launched from.
 */
export function envWithoutSessionVars(): NodeJS.ProcessEnv {
  const {
    BODHILANDER_SESSION_ID: _id,
    BODHILANDER_SOCKET: _socket,
    BODHILANDER_API_URL: _apiUrl,
    ...rest
  } = process.env;
  return rest;
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
      accounts: false,
    },
    buildCommand: (config) => ({
      command: opts.command,
      args: [],
      env: baseSessionEnv(config),
    }),
  };
}
