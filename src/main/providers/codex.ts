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
});
