import { passthroughProvider } from './passthrough';

/**
 * Google Gemini CLI (`gemini`). Auth is handled by the CLI itself
 * (Google login / GEMINI_API_KEY). Conversation resume is interactive inside
 * the TUI rather than flag-addressable, so stored-UUID resume is disabled.
 */
export const geminiProvider = passthroughProvider({
  id: 'gemini',
  name: 'Gemini CLI (Google)',
  command: 'gemini',
  setup: {
    installHint: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    loginHint: 'Run `gemini` and sign in with your Google account, or set GEMINI_API_KEY',
  },
});
