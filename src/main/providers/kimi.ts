import { passthroughProvider } from './passthrough';
import { kimiParser } from '../arena/parsers';

/**
 * Kimi Code (Moonshot AI, `kimi`). Auth is handled by the CLI itself
 * (`kimi login` device-code flow) and works out of the box on the free tier,
 * so no single API-key env var is wired into the key vault. Sessions launch
 * the interactive TUI bare, like the other passthrough CLIs.
 */
export const kimiProvider = passthroughProvider({
  id: 'kimi',
  name: 'Kimi Code',
  command: 'kimi',
  arena: {
    // -p runs one prompt non-interactively; stream-json emits assistant
    // content lines plus a meta resume_hint carrying the session id. Headless
    // -p already auto-approves tool reads, so folder-scoped questions work
    // without a permission flag (--auto/--yolo are in fact rejected alongside
    // --prompt). kimi mints its own session id (session_...), captured by the
    // parser; follow-up rounds resume via -r <id>.
    buildCommand: (promptRef) => `kimi -p ${promptRef} --output-format stream-json`,
    buildResumeCommand: (promptRef, sessionRef) =>
      `kimi -r ${sessionRef} -p ${promptRef} --output-format stream-json`,
    createParser: kimiParser,
  },
  setup: {
    installHint: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    installCommand: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    docsUrl: 'https://moonshotai.github.io/kimi-code/',
    loginHint: 'Works out of the box; run `kimi login` to use your own Moonshot account',
  },
});
