import { passthroughProvider } from './passthrough';
import { textParser } from '../arena/parsers';

/**
 * xAI Grok Build (`grok`, per https://docs.x.ai/build/overview). Auth is
 * handled by the CLI itself (`grok-build login` / XAI_API_KEY for headless).
 * No documented session-resume or system-prompt flags as of v0.1.
 */
export const grokProvider = passthroughProvider({
  id: 'grok',
  name: 'Grok Build (xAI)',
  command: 'grok',
  apiKey: {
    envVar: 'XAI_API_KEY',
    test: {
      url: 'https://api.x.ai/v1/models',
      headers: (key) => ({ authorization: `Bearer ${key}` }),
    },
  },
  arena: {
    // Plain-text headless output; no documented JSON/usage reporting yet.
    // `-p` is hard single-turn: it prints the model's first message and
    // exits 0, so with default plan mode on, a codebase question ends after
    // an "I'll explore..." preamble with the tools never run. --no-plan +
    // auto permissions let the model finish its exploration and answer
    // within that single turn (verified live; --max-turns does not help).
    // --session-id names the session upfront; follow-up rounds --resume it
    // (same id is kept — grok only rotates with --fork-session).
    buildCommand: (promptRef, sessionRef) =>
      `grok --session-id ${sessionRef} --no-plan --permission-mode auto -p ${promptRef}`,
    buildResumeCommand: (promptRef, sessionRef) =>
      `grok --resume ${sessionRef} --no-plan --permission-mode auto -p ${promptRef}`,
    createParser: textParser,
  },
  setup: {
    installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    docsUrl: 'https://docs.x.ai/build/overview',
    loginHint: 'Run `grok` — the first launch prompts sign-in with your X/xAI account (requires SuperGrok or X Premium+)',
  },
});
