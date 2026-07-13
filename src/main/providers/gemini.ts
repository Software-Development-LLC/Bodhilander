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
});
