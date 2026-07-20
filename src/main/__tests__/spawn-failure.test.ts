/**
 * Provider CLI launch-failure classification tests.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { classifySpawnFailure } from '../spawn-failure';

describe('classifySpawnFailure', () => {
  describe("'missing' — shell can't find the CLI", () => {
    test('zsh', () => {
      expect(classifySpawnFailure('codex', 'zsh: command not found: codex')).toBe('missing');
    });

    test('bash', () => {
      expect(classifySpawnFailure('codex', 'bash: line 1: codex: command not found')).toBe('missing');
    });

    test('POSIX exec', () => {
      expect(classifySpawnFailure('grok', 'grok: No such file or directory')).toBe('missing');
    });

    test('cmd.exe', () => {
      expect(classifySpawnFailure(
        'codex',
        "'codex' is not recognized as an internal or external command,\noperable program or batch file."
      )).toBe('missing');
    });

    test('PowerShell', () => {
      expect(classifySpawnFailure(
        'codex',
        "The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program."
      )).toBe('missing');
    });

    test('requires the provider command name — another missing command does not match', () => {
      expect(classifySpawnFailure('codex', 'zsh: command not found: fooBar')).toBeNull();
      expect(classifySpawnFailure('codex', 'bash: rg: command not found')).toBeNull();
    });

    test('matches through ANSI coloring', () => {
      expect(classifySpawnFailure('codex', '\x1b[31mzsh: command not found: codex\x1b[0m')).toBe('missing');
    });
  });

  describe("'broken' — CLI launched but its startup failed", () => {
    // Verbatim from the user report that motivated this: codex's npm wrapper
    // spawning a native platform binary npm never installed.
    const codexEnoent = `Error: spawn /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex ENOENT
    at ChildProcess._handle.onexit (node:internal/child_process:286:19)
    at onErrorNT (node:internal/child_process:484:16)
    at process.processTicksAndRejections (node:internal/process/task_queues:89:21) {
  errno: -2,
  code: 'ENOENT',
  syscall: 'spawn /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex',
  path: '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex',
  spawnargs: []
}`;

    test('npm wrapper spawn ENOENT (codex user report)', () => {
      expect(classifySpawnFailure('codex', codexEnoent)).toBe('broken');
    });

    test('Rosetta / architecture mismatch (zsh lowercase and loader capitalized)', () => {
      expect(classifySpawnFailure('codex', 'zsh: bad CPU type in executable: codex')).toBe('broken');
      expect(classifySpawnFailure('codex', '/usr/bin/arch: Bad CPU type in executable')).toBe('broken');
    });

    test('macOS dynamic-link failure', () => {
      expect(classifySpawnFailure(
        'claude',
        "dyld[4242]: Library not loaded: @rpath/libnode.dylib"
      )).toBe('broken');
    });

    test("'missing' wins when both shapes appear", () => {
      const both = `zsh: command not found: codex\nError: spawn /x/y ENOENT`;
      expect(classifySpawnFailure('codex', both)).toBe('missing');
    });
  });

  describe('normal startup output', () => {
    test('banner and prompt output is not a failure', () => {
      expect(classifySpawnFailure('claude', 'Welcome to Claude Code!\n\n> Try "fix the build"')).toBeNull();
      expect(classifySpawnFailure('codex', 'OpenAI Codex v0.48.2\nThinking...')).toBeNull();
    });

    test('empty output is not a failure', () => {
      expect(classifySpawnFailure('codex', '')).toBeNull();
    });
  });
});
