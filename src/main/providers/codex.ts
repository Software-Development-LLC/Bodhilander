import { passthroughProvider } from './passthrough';

/**
 * OpenAI Codex CLI (`codex`). Auth is handled by the CLI itself
 * (`codex login` / OPENAI_API_KEY). Codex manages its own conversation ids
 * (`codex resume` picker) and offers no flag to assign one up front, so
 * Bodhilander's stored-UUID resume machinery is disabled.
 */
export const codexProvider = passthroughProvider({
  id: 'codex',
  name: 'Codex (OpenAI)',
  command: 'codex',
  setup: {
    installHint: 'npm install -g @openai/codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    loginHint: 'Run `codex login` (ChatGPT account) or set OPENAI_API_KEY',
  },
});
