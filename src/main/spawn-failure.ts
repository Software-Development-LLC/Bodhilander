/**
 * Provider CLI launch-failure classification.
 *
 * When an agent session's CLI fails to start, the user is left staring at a
 * raw shell or Node error in the terminal. Session output from the first few
 * seconds is classified here so the renderer can show a friendly banner with
 * the provider's install command instead.
 *
 * Two failure shapes:
 * - 'missing' — the shell couldn't find the CLI on PATH at all.
 * - 'broken'  — the CLI launched but its own startup failed. Canonical case:
 *   an npm wrapper (e.g. @openai/codex) spawning its native platform binary
 *   that isn't on disk — npm dropped the platform optionalDependency, the
 *   install ran under a Rosetta x64 Node, or security software stripped the
 *   unsigned binary. Surfaces as `Error: spawn <path> ENOENT`.
 *
 * (Pure module — no node-pty import — so tests don't drag the native module in.)
 */

export type SpawnFailureKind = 'missing' | 'broken';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shell "command not found" shapes, parameterized by CLI name so unrelated
 * output (an agent compiling code, say) can't trigger the hint:
 * - zsh:        `zsh: command not found: codex`
 * - bash/dash:  `bash: line 1: codex: command not found`
 * - POSIX exec: `codex: No such file or directory`
 * - cmd.exe:    `'codex' is not recognized as an internal or external command`
 * - PowerShell: `The term 'codex' is not recognized as the name of a cmdlet`
 */
function missingPatterns(command: string): RegExp[] {
  const cmd = escapeRegExp(command);
  return [
    new RegExp(`command not found:\\s*${cmd}\\b`),
    new RegExp(`\\b${cmd}: command not found`),
    new RegExp(`\\b${cmd}: No such file or directory`),
    new RegExp(`'${cmd}' is not recognized as an internal or external command`),
    new RegExp(`The term '${cmd}' is not recognized`),
  ];
}

/**
 * Startup failures of an installed-but-broken CLI. Not parameterized by
 * command name — the failing path is internal to the CLI's own package (e.g.
 * .../@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex) —
 * so callers must only run this against EARLY session output, before the
 * agent itself could plausibly print such an error from running user code.
 */
const BROKEN_PATTERNS: readonly RegExp[] = [
  /spawn [^\n]{1,500}ENOENT/,          // Node launcher can't find its native binary
  /bad CPU type in executable/i,       // arch mismatch (Rosetta-installed x64 pkg)
  /cannot execute binary file/,
  /dyld(\[\d+\])?: Library not loaded/, // macOS dynamic-link failure
];

/** ANSI CSI/OSC stripper (same grammar as pty-manager's state detector). */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // NOSONAR(S6324) ESC required to strip CSI sequences
    .replace(/\x1b\][^\x07]*\x07/g, ''); // NOSONAR(S6324) ESC/BEL delimit OSC sequences
}

/**
 * Classify early session output as a CLI launch failure, or null if it looks
 * like a normal startup. `command` is the provider's CLI binary name.
 */
export function classifySpawnFailure(command: string, output: string): SpawnFailureKind | null {
  const text = stripAnsi(output);
  if (missingPatterns(command).some((p) => p.test(text))) {
    return 'missing';
  }
  if (BROKEN_PATTERNS.some((p) => p.test(text))) {
    return 'broken';
  }
  return null;
}
