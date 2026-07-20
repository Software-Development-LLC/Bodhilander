import { passthroughProvider } from './passthrough';
import { codexParser } from '../arena/parsers';

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
  apiKey: {
    envVar: 'OPENAI_API_KEY',
    test: {
      url: 'https://api.openai.com/v1/models',
      headers: (key) => ({ authorization: `Bearer ${key}` }),
    },
  },
  arena: {
    // JSONL events; turn.completed carries token usage (OpenAI headless
    // docs). --skip-git-repo-check: codex refuses to run outside a trusted
    // git directory otherwise, which breaks unscoped arena runs (cwd = the
    // app dir). Codex mints its own thread id — the engine's assigned
    // sessionRef is ignored and the parser captures thread.started instead;
    // follow-up rounds resume that thread (verified live).
    buildCommand: (promptRef) => `codex exec --json --skip-git-repo-check ${promptRef}`,
    buildResumeCommand: (promptRef, sessionRef) =>
      `codex exec resume ${sessionRef} --json --skip-git-repo-check ${promptRef}`,
    createParser: codexParser,
  },
  setup: {
    installHint: 'npm install -g @openai/codex',
    // --force so re-running repairs broken installs — the classic failure is
    // npm dropping @openai/codex-<platform>'s vendored native binary, which
    // then dies with `spawn ... ENOENT` (user report, 2026-07).
    installCommand: 'npm install -g --force @openai/codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    loginHint: 'Run `codex login` (ChatGPT account) or set OPENAI_API_KEY',
  },
});
