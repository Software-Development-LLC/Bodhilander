import { passthroughProvider } from './passthrough';
import { textParser } from '../arena/parsers';

/**
 * Google Antigravity CLI (`agy`). Auth is the Antigravity app's Google
 * sign-in; sessions launch the interactive TUI bare, like the other
 * passthrough CLIs.
 *
 * Headless output is plain text with no machine-readable conversation id, and
 * a fresh id cannot be assigned up front (verified live: --conversation only
 * resumes agy's own on-disk ids, which never appear in stdout). Its only
 * resume path is --continue, which targets the globally most-recent
 * conversation and so can't reliably re-enter a specific arena column under
 * concurrent use. Rather than resume the wrong conversation, arena follow-up
 * is deliberately not supported: buildResumeCommand is omitted, so the engine
 * skips this column in later rounds (it still answers the initial prompt and
 * works as a normal session provider).
 */
export const antigravityProvider = passthroughProvider({
  id: 'antigravity',
  name: 'Antigravity',
  command: 'agy',
  arena: {
    // -p runs one prompt non-interactively and prints plain text.
    // --dangerously-skip-permissions is antigravity's headless auto-approve
    // (its own error message prescribes it): without it, tool-using questions
    // — e.g. a folder-scoped "analyze this codebase" — are auto-denied and
    // produce no output. Same auto-approve tradeoff arena already makes for
    // the other CLIs (grok --permission-mode auto, cursor --force, opencode
    // --auto).
    buildCommand: (promptRef) => `agy --dangerously-skip-permissions -p ${promptRef}`,
    createParser: textParser,
  },
  setup: {
    installHint: 'Install Antigravity from https://antigravity.google, then run `agy install`',
    docsUrl: 'https://antigravity.google',
    loginHint: 'Sign in through the Antigravity app (Google account)',
  },
});
