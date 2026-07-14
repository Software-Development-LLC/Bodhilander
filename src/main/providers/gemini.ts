import { passthroughProvider } from './passthrough';
import { geminiParser } from '../arena/parsers';

/**
 * Google Gemini CLI (`gemini`). Auth is handled by the CLI itself
 * (Google login / GEMINI_API_KEY). Conversation resume is interactive inside
 * the TUI rather than flag-addressable, so stored-UUID resume is disabled.
 */
export const geminiProvider = passthroughProvider({
  id: 'gemini',
  name: 'Gemini CLI (Google)',
  command: 'gemini',
  apiKey: {
    envVar: 'GEMINI_API_KEY',
    test: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      headers: (key) => ({ 'x-goog-api-key': key }),
    },
  },
  arena: {
    // Single JSON document with response + per-model token stats
    // (Gemini CLI headless docs); no streaming.
    buildCommand: (promptRef) => `gemini -p ${promptRef} --output-format json`,
    createParser: geminiParser,
  },
  setup: {
    installHint: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    loginHint: 'Run `gemini` and sign in with your Google account, or set GEMINI_API_KEY',
  },
});
