/**
 * Gate command tests (CO-722).
 *
 * A dropped or mistaken flag here is not a crash — it is a reviewer that can
 * rewrite the branch it is reviewing, or a gate that inherits a stranger's
 * settings and reaches a different verdict while reporting honestly. Nothing
 * downstream notices either. So the assertions are about the argv itself.
 *
 * Every expectation traces to a measurement against Claude Code 2.1.263, not
 * to documentation. Where a measurement contradicted the design, the test
 * names the contradiction.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import { buildGateCommand, type GateSpec, type RunSpawnContext } from '../gate-command';
import type { AgentDefinition } from '../agent-definition';

const CONTEXT: RunSpawnContext = {
  harnessPath: '/plugins/bodhi',
  bodhiRoot: '/root',
  cwd: '/root/_wt-k-1-web-apps',
  pythonPath: '/usr/bin/python3',
  posture: 'manual',
  sessionId: '11111111-2222-3333-4444-555555555555',
  receiptPath: '/root/initiatives/K-1/gates/3-reviewer.json',
  permissionPromptTool: 'mcp__bodhilander__approve',
  systemPromptPath: '/tmp/run-1/gate-3-role.md',
};

const REVIEWER_AGENT: AgentDefinition = {
  name: 'bodhi:reviewer',
  tools: ['Read', 'Bash', 'Grep', 'Glob'],
  body: 'You are the reviewer. Walk the path a person takes.',
};

const OWNER_AGENT: AgentDefinition = {
  name: 'bodhi:staff:bwa-lead',
  tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  body: 'You are the owner for bodhi-web-apps.',
};

const REVIEWER: GateSpec = {
  gate: 3,
  agent: REVIEWER_AGENT,
  mode: 'print',
  schema: { type: 'object', properties: { verdict: { type: 'string' } } },
};

const OWNER: GateSpec = { gate: 2, agent: OWNER_AGENT, mode: 'background' };

/** The value following `flag`, or undefined. */
function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

describe('what every gate gets', () => {
  test('the harness is pinned, so a gate cannot pick up another copy', () => {
    // Three copies were reachable in one 18-hour window, and two agents on the
    // same initiative could reach opposite verdicts while both reported
    // honestly. --plugin-dir makes that structurally impossible.
    const { argv } = buildGateCommand(REVIEWER, CONTEXT, 'go');
    expect(valueOf(argv, '--plugin-dir')).toBe('/plugins/bodhi');
  });

  test('a background gate names the agent plugin-qualified', () => {
    // The qualified form cannot be shadowed by another plugin shipping the
    // same role. An unresolvable name fails loudly and lists the
    // alternatives, rather than falling back to a full grant.
    expect(valueOf(buildGateCommand(OWNER, CONTEXT, 'go').argv, '--agent'))
      .toBe('bodhi:staff:bwa-lead');
  });

  test('settings are NOT inherited from the machine', () => {
    // Two machines must not reach different verdicts on the same branch.
    const { argv } = buildGateCommand(REVIEWER, CONTEXT, 'go');
    expect(argv).toContain('--setting-sources');
    expect(valueOf(argv, '--setting-sources')).toBe('');
    expect(argv).toContain('--strict-mcp-config');
  });

  test('the gate runs in the owner worktree, never the shared checkout', () => {
    expect(buildGateCommand(REVIEWER, CONTEXT, 'go').cwd).toBe('/root/_wt-k-1-web-apps');
  });

  test('the session is named up front so it can be resumed after it exits', () => {
    const { argv } = buildGateCommand(REVIEWER, CONTEXT, 'go');
    expect(valueOf(argv, '--session-id')).toBe(CONTEXT.sessionId);
  });

  test('a budget ceiling is a flag, not a document', () => {
    const { argv } = buildGateCommand(REVIEWER, { ...CONTEXT, budgetUsd: 7.5 }, 'go');
    expect(valueOf(argv, '--max-budget-usd')).toBe('7.5');
  });

  test('no budget means no flag, rather than a zero that would stop everything', () => {
    const { argv } = buildGateCommand(REVIEWER, { ...CONTEXT, budgetUsd: null }, 'go');
    expect(argv).not.toContain('--max-budget-usd');
  });
});

describe('the tool grant comes from the plugin, not from here', () => {
  test('--allowedTools is NEVER emitted', () => {
    // MEASURED: with --allowedTools "Read,Grep,Glob" --permission-mode manual,
    // Bash ran to completion with permission_denials: []. It is a
    // pre-approval list, not a capability set. Emitting it would look like a
    // restriction and be none.
    for (const spec of [REVIEWER, OWNER]) {
      const { argv } = buildGateCommand(spec, CONTEXT, 'go');
      expect(argv).not.toContain('--allowedTools');
      expect(argv).not.toContain('--allowed-tools');
    }
  });

  test('a reading gate passes --tools, and it is the AGENT\'S list verbatim', () => {
    // --tools is the flag that actually restricts, and print mode must send
    // it because --agent (which would carry the grant itself) suppresses
    // structured_output. The list is never composed here: it is whatever the
    // agent file declared, so it cannot drift from the file it came from.
    const { argv } = buildGateCommand(REVIEWER, CONTEXT, 'go');
    expect(valueOf(argv, '--tools')).toBe(REVIEWER_AGENT.tools.join(','));
  });

  test('a reading gate gets no Write and no Edit', () => {
    // The property all of this exists for: a reviewer that can rewrite the
    // branch it is reviewing is the failure the plugin's own CI check names.
    const granted = valueOf(buildGateCommand(REVIEWER, CONTEXT, 'go').argv, '--tools')!
      .split(',');
    expect(granted).not.toContain('Write');
    expect(granted).not.toContain('Edit');
  });

  test('an owner DOES get them, so the reviewer case is not vacuous', () => {
    // CONTROL: if the grant were being dropped rather than forwarded, the
    // assertion above would pass while proving nothing.
    expect(OWNER_AGENT.tools).toContain('Write');
    expect(OWNER_AGENT.tools).toContain('Edit');
  });

  test('a background gate lets the plugin resolve the grant, so sends no --tools', () => {
    // It can afford to: its verdict is a receipt file, not structured output,
    // so it keeps --agent and with it the plugin's own composition and hooks.
    expect(buildGateCommand(OWNER, CONTEXT, 'go').argv).not.toContain('--tools');
  });
});

describe('permission posture', () => {
  test('manual routes prompts to the host, which is how the app becomes the surface', () => {
    const { argv } = buildGateCommand(REVIEWER, CONTEXT, 'go');
    expect(valueOf(argv, '--permission-mode')).toBe('manual');
    expect(valueOf(argv, '--permission-prompts')).toBe('host');
    expect(valueOf(argv, '--permission-prompt-tool')).toBe('mcp__bodhilander__approve');
  });

  test('denyOnPrompt fails CLOSED and asks nobody', () => {
    const { argv } = buildGateCommand(REVIEWER, { ...CONTEXT, posture: 'denyOnPrompt' }, 'go');
    expect(valueOf(argv, '--permission-prompts')).toBe('none');
    expect(argv).not.toContain('--permission-prompt-tool');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  test('bypass is the only posture that skips checks, and only when asked for', () => {
    const { argv } = buildGateCommand(REVIEWER, { ...CONTEXT, posture: 'bypass' }, 'go');
    expect(argv).toContain('--dangerously-skip-permissions');
  });

  test('no other posture skips permission checks', () => {
    // CONTROL. Without this, a posture that fell through to bypass would pass
    // its own test and silently unsandbox every gate.
    for (const posture of ['manual', 'denyOnPrompt'] as const) {
      const { argv } = buildGateCommand(REVIEWER, { ...CONTEXT, posture }, 'go');
      expect({ posture, skips: argv.includes('--dangerously-skip-permissions') })
        .toEqual({ posture, skips: false });
    }
  });

  test('manual without a handler still asks the host rather than silently allowing', () => {
    const { argv } = buildGateCommand(
      REVIEWER, { ...CONTEXT, permissionPromptTool: null }, 'go',
    );
    expect(valueOf(argv, '--permission-prompts')).toBe('host');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });
});

describe('print mode: the reading gates', () => {
  test('asks for a schema-validated verdict', () => {
    const { argv } = buildGateCommand(REVIEWER, CONTEXT, 'go');
    expect(argv).toContain('--print');
    expect(valueOf(argv, '--output-format')).toBe('json');
    expect(valueOf(argv, '--json-schema')).toBe(JSON.stringify(REVIEWER.schema));
  });

  test('the prompt goes on STDIN, never in argv', () => {
    // MEASURED: a variadic option swallows a trailing positional --
    // `--tools a,b,c '<prompt>'` failed with "Input must be provided either
    // through stdin or as a prompt argument". stdin removes the ordering
    // hazard entirely, and keeps the prompt text out of the command line.
    const prompt = 'review the branch and say whether an operator can do the job';
    const cmd = buildGateCommand(REVIEWER, CONTEXT, prompt);
    expect(cmd.stdin).toBe(prompt);
    expect(cmd.argv).not.toContain(prompt);
  });

  test('carries the agent BODY, not --agent, which suppresses structured_output', () => {
    // MEASURED: --agent + --json-schema returns subtype success, is_error
    // false, exit 0 and NO structured_output -- even when the agent completes
    // the task. A reading gate exists to produce a verdict, so it takes the
    // route that returns one.
    const { argv } = buildGateCommand(REVIEWER, CONTEXT, 'go');
    expect(valueOf(argv, '--append-system-prompt-file')).toBe(CONTEXT.systemPromptPath);
    expect(argv).not.toContain('--agent');

    // A PATH, never the text. reviewer.md's body is 37,429 characters, and
    // inline it exceeds Windows' 32,767-character command line -- measured as
    // `ENAMETOOLONG: uv_spawn`, before the process starts.
    expect(argv).not.toContain('--append-system-prompt');
    expect(argv).not.toContain(REVIEWER_AGENT.body);
    for (const arg of argv) expect(arg.length).toBeLessThan(4096);
  });

  test('never carries --bg, because --bg and --print conflict', () => {
    // MEASURED: "--bg and --print conflict: --print never starts the
    // interactive session that `claude agents` attaches to".
    expect(buildGateCommand(REVIEWER, CONTEXT, 'go').argv).not.toContain('--bg');
  });

  test('a gate with no schema still runs, it just returns unvalidated text', () => {
    const { argv } = buildGateCommand({ ...REVIEWER, schema: undefined }, CONTEXT, 'go');
    expect(argv).not.toContain('--json-schema');
    expect(argv).toContain('--print');
  });
});

describe('background mode: the owner', () => {
  test('is attachable, which is what makes a stuck owner recoverable', () => {
    const { argv } = buildGateCommand(OWNER, CONTEXT, 'go');
    expect(argv).toContain('--bg');
    expect(argv).not.toContain('--print');
  });

  test('the prompt is the LAST argument, after a non-variadic flag', () => {
    // The ordering hazard in the other direction: --bg takes the prompt as a
    // positional, so whatever precedes it must take exactly one value or the
    // prompt is consumed as that value.
    const prompt = 'implement the issue in this worktree, push, and stop';
    const { argv, stdin } = buildGateCommand(OWNER, CONTEXT, prompt);
    expect(argv[argv.length - 1]).toBe(prompt);
    expect(argv[argv.length - 3]).toBe('--session-id');
    expect(stdin).toBeNull();
  });

  test('carries no --json-schema, which needs --print', () => {
    const { argv } = buildGateCommand(
      { ...OWNER, schema: { type: 'object' } }, CONTEXT, 'go',
    );
    expect(argv).not.toContain('--json-schema');
    expect(argv).not.toContain('--output-format');
  });
});

describe('the child environment', () => {
  test('passes the resolved interpreter, so the wrappers do not trust the name', () => {
    // The plugin's wrappers probe BODHI_PYTHON ahead of PATH. On Windows
    // `python3` can be a Store alias that is not Python at all.
    expect(buildGateCommand(REVIEWER, CONTEXT, 'go').env.BODHI_PYTHON)
      .toBe('/usr/bin/python3');
  });

  test('forces UTF-8, or every em-dash the plugin prints becomes a replacement char', () => {
    const { env } = buildGateCommand(REVIEWER, CONTEXT, 'go');
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
  });

  test('names where the receipt goes, which is load-bearing for a --bg gate', () => {
    // A background gate cannot return a schema-validated verdict, and
    // `claude logs` yields raw TUI ANSI rather than events. The receipt file
    // is the only structured thing it can leave behind.
    expect(buildGateCommand(OWNER, CONTEXT, 'go').env.BODHI_GATE_RECEIPT)
      .toBe(CONTEXT.receiptPath);
  });

  test('omits BODHI_PYTHON when none was resolved, rather than passing empty', () => {
    // An empty value would be honoured ahead of PATH and resolve to nothing.
    const { env } = buildGateCommand(REVIEWER, { ...CONTEXT, pythonPath: null }, 'go');
    expect('BODHI_PYTHON' in env).toBe(false);
  });

  test('always names the workspace root', () => {
    expect(buildGateCommand(REVIEWER, CONTEXT, 'go').env.BODHI_ROOT).toBe('/root');
  });
});
