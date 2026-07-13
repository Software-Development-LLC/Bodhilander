import { passthroughProvider } from './passthrough';

/**
 * xAI Grok Build (`grok`, per https://docs.x.ai/build/overview). Auth is
 * handled by the CLI itself (`grok-build login` / XAI_API_KEY for headless).
 * No documented session-resume or system-prompt flags as of v0.1.
 */
export const grokProvider = passthroughProvider({
  id: 'grok',
  name: 'Grok Build (xAI)',
  command: 'grok',
});
