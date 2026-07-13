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
  setup: {
    installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    docsUrl: 'https://docs.x.ai/build/overview',
    loginHint: 'Run `grok` — the first launch prompts sign-in with your X/xAI account (requires SuperGrok or X Premium+)',
  },
});
