import { passthroughProvider } from './passthrough';
import { cursorParser } from '../arena/parsers';

/**
 * Cursor Agent (`cursor-agent`). Auth is handled by the CLI itself
 * (`cursor-agent login`, or the CURSOR_API_KEY env var). The bare command is
 * deliberately `cursor-agent`, not the `agent` alias its installer also
 * drops on PATH — `agent` collides with grok's own `agent` alias, whereas
 * `cursor-agent` is unambiguous. Sessions launch the interactive TUI bare.
 */
export const cursorProvider = passthroughProvider({
  id: 'cursor',
  name: 'Cursor Agent',
  command: 'cursor-agent',
  arena: {
    // -p/--print is the headless entry; stream-json is Claude-shaped. --force
    // auto-allows tool calls and --trust trusts the workspace so folder-scoped
    // questions can read files headlessly (both verified live; without --trust
    // a git workspace blocks tool use). cursor mints its own session id (a
    // UUID), captured by the parser from session_id; follow-up rounds resume
    // via --resume <id>.
    buildCommand: (promptRef) =>
      `cursor-agent -p --output-format stream-json --force --trust ${promptRef}`,
    buildResumeCommand: (promptRef, sessionRef) =>
      `cursor-agent -p --output-format stream-json --force --trust --resume ${sessionRef} ${promptRef}`,
    createParser: cursorParser,
  },
  setup: {
    installHint: 'curl https://cursor.com/install -fsS | bash',
    installCommand: 'curl https://cursor.com/install -fsS | bash',
    docsUrl: 'https://cursor.com/docs/cli/overview',
    loginHint: 'Run `cursor-agent login` (or set CURSOR_API_KEY)',
  },
});
