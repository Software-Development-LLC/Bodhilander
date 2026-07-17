import { passthroughProvider } from './passthrough';
import { opencodeParser } from '../arena/parsers';

/**
 * opencode (sst/opencode). A multi-provider agent CLI: auth is per-model
 * provider, managed by the CLI itself (`opencode auth login`), so there is no
 * single API-key env var and Bodhilander's key vault is not wired up here.
 * Sessions launch the interactive TUI bare, like the other passthrough CLIs.
 */
export const opencodeProvider = passthroughProvider({
  id: 'opencode',
  name: 'opencode',
  command: 'opencode',
  arena: {
    // `run` is the headless entry; --format json emits newline-delimited
    // events. --auto approves tool use so folder-scoped questions can read
    // files (verified live; without it a read prompt would stall). opencode
    // mints its own session id (ses_...), captured by the parser from the
    // sessionID field, so the engine's pre-assigned ref is ignored. Follow-up
    // rounds resume via -s <id>.
    buildCommand: (promptRef) => `opencode run --auto --format json ${promptRef}`,
    buildResumeCommand: (promptRef, sessionRef) =>
      `opencode run --auto -s ${sessionRef} --format json ${promptRef}`,
    createParser: opencodeParser,
  },
  setup: {
    installHint: 'curl -fsSL https://opencode.ai/install | bash',
    docsUrl: 'https://opencode.ai/docs',
    loginHint: 'Run `opencode auth login` and add a provider (or set that provider’s API key)',
  },
});
