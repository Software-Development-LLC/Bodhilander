/**
 * Turning a gate into the exact `claude` command line (CO-722).
 *
 * Pure: it builds an argv, an env and a cwd, and runs nothing. That is what
 * makes "does a reviewer get Write?" a snapshot assertion instead of something
 * you find out by reading a diff an agent should never have been able to
 * produce.
 *
 * Every flag here was verified against Claude Code 2.1.263 rather than taken
 * from documentation, and three of those measurements contradicted what the
 * design assumed:
 *
 * - `--allowedTools` does NOT restrict anything. With
 *   `--allowedTools "Read,Grep,Glob" --permission-mode manual`, Bash ran to
 *   completion with `permission_denials: []`. It is a pre-approval list. This
 *   module never emits it, and a test asserts that.
 * - `--bg` and `--print` conflict outright, so a gate cannot be both
 *   attachable and verdict-shaped. Owners get `--bg`; the reading gates get
 *   `-p`.
 * - a variadic option swallows a trailing positional, so a prompt placed
 *   after one is consumed as a value. Print mode therefore passes the prompt
 *   on **stdin**, which also keeps it out of argv entirely.
 *
 * The two modes also differ in how the agent reaches the CLI, and that is a
 * measurement rather than a preference. `--agent` and `--json-schema` do NOT
 * compose: a run with `--agent bodhi:reviewer` and a schema returns
 * `subtype: success`, `is_error: false`, exit 0 and **no**
 * `structured_output` — even when the agent completes the task. So:
 *
 * - the reading gates pass the agent's own body via
 *   `--append-system-prompt-FILE` and its own `tools:` via `--tools`, which
 *   returns the validated object and the same restricted set (`Bash, Glob,
 *   Grep, Read` — no Write, no Edit). The file matters: reviewer.md's body is
 *   37,429 characters and passing it inline exceeds Windows' 32,767-character
 *   command line, failing with `ENAMETOOLONG` before the process starts;
 * - the owner gate keeps `--agent`, which it can afford because its verdict
 *   comes from a receipt file, and which keeps the plugin's own composition,
 *   hooks and grant intact. An unresolvable name there fails loudly and lists
 *   the alternatives rather than falling back to a full grant.
 *
 * Neither path RESTATES a grant. Both read it from the agent file in the
 * pinned harness, because a copy of it here could drift from the file it
 * copies — and domain knowledge is the one thing this engine may not hold.
 *
 * That a verdict can simply be ABSENT, with every success signal set, is why
 * "no verdict is inconclusive, never a pass" is load-bearing rather than
 * defensive.
 */
import type { Gate } from './transitions';
import type { AgentDefinition } from './agent-definition';
import type { PermissionPosture } from '../repositories/runs';

export class GateCommandError extends Error {}

/** How a gate is invoked. The two are mutually exclusive — see the header. */
export type GateMode = 'background' | 'print';

export interface GateSpec {
  gate: Gate;
  /** Read from the pinned harness. Never composed here. */
  agent: AgentDefinition;
  mode: GateMode;
  /** Verdict shape. Print mode only: `--json-schema` needs `--print`. */
  schema?: object;
}

export interface RunSpawnContext {
  harnessPath: string;
  bodhiRoot: string;
  /** Where the gate works. An owner's worktree, never the shared checkout. */
  cwd: string;
  /**
   * The resolved interpreter, passed to the plugin's wrappers as
   * `BODHI_PYTHON`. They probe it rather than trusting the name `python3`,
   * which on Windows can be a Store alias that is not Python.
   */
  pythonPath?: string | null;
  posture: PermissionPosture;
  budgetUsd?: number | null;
  /** Named up front so the conversation can be resumed after it exits. */
  sessionId: string;
  /** Where the gate writes its receipt. Load-bearing for `--bg`. */
  receiptPath?: string | null;
  /**
   * File holding the agent's body, for print mode.
   *
   * A PATH, never the text. The bodies are real: reviewer.md is 37,429
   * characters, and passing that inline exceeds Windows' 32,767-character
   * command line — `ENAMETOOLONG: uv_spawn`, before the process starts.
   * The caller writes the file; this module only names it.
   */
  systemPromptPath?: string | null;
  /** MCP tool answering permission prompts, for the `manual` posture. */
  permissionPromptTool?: string | null;
  mcpConfigPath?: string | null;
}

export interface GateCommand {
  argv: string[];
  /** Print mode delivers the prompt here. Null when it is a positional. */
  stdin: string | null;
  cwd: string;
  env: Record<string, string>;
}

/**
 * Permission flags for a posture.
 *
 * `manual` is the default and needs somewhere to ask: `--permission-prompts
 * host` routes a prompt to the handler named by `--permission-prompt-tool`,
 * which is how Bodhilander becomes the surface. Measured working end to end —
 * a handler received the tool name and full input, its deny was honoured and
 * the write never happened, and its allow round-tripped.
 *
 * Only genuinely gated actions ever arrive: `echo` is auto-classified safe and
 * never prompts, so routine work does not spam the surface.
 */
function permissionFlags(context: RunSpawnContext): string[] {
  switch (context.posture) {
    case 'bypass':
      return ['--dangerously-skip-permissions'];
    case 'denyOnPrompt':
      // Fails closed: anything that would prompt is denied, nobody is asked.
      return ['--permission-mode', 'manual', '--permission-prompts', 'none'];
    case 'manual':
    default: {
      const flags = ['--permission-mode', 'manual', '--permission-prompts', 'host'];
      if (context.permissionPromptTool) {
        flags.push('--permission-prompt-tool', context.permissionPromptTool);
      }
      return flags;
    }
  }
}

/**
 * Env for the child.
 *
 * `PYTHONUTF8`/`PYTHONIOENCODING` are not cosmetic: without them every em-dash
 * the plugin prints arrives as a replacement character on Windows, and those
 * lines end up in receipts and in the run view.
 */
function gateEnv(context: RunSpawnContext): Record<string, string> {
  const env: Record<string, string> = {
    BODHI_ROOT: context.bodhiRoot,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  if (context.pythonPath) env.BODHI_PYTHON = context.pythonPath;
  if (context.receiptPath) env.BODHI_GATE_RECEIPT = context.receiptPath;
  return env;
}

/**
 * The exact command for one gate.
 *
 * `--setting-sources ""` is deliberate: a gate must not inherit whatever
 * settings happen to exist on the machine it runs on, or two machines reach
 * different verdicts on the same branch and both report honestly.
 */
export function buildGateCommand(
  spec: GateSpec,
  context: RunSpawnContext,
  prompt: string,
): GateCommand {
  const argv: string[] = [];

  // Pinned first: the harness and the agent decide what this even is. Three
  // plugin copies were reachable in one 18-hour window and need not agree.
  argv.push('--plugin-dir', context.harnessPath);
  argv.push('--setting-sources', '');
  argv.push('--strict-mcp-config');
  if (context.mcpConfigPath) argv.push('--mcp-config', context.mcpConfigPath);
  argv.push(...permissionFlags(context));
  if (context.budgetUsd != null) {
    // The plugin documents its budget as "a ceiling, not a target" and nothing
    // enforced it. Here it is a flag.
    argv.push('--max-budget-usd', String(context.budgetUsd));
  }

  if (spec.mode === 'print') {
    // Refuse rather than build a command with no role. Skipping the flag
    // would still emit --tools and --json-schema, so the gate would run with
    // the right restrictions, produce a SCHEMA-VALID verdict from a generic
    // assistant, and be recorded in the run history as bodhi:reviewer. A
    // verdict that looks right and came from nobody is worse than no verdict,
    // because nothing downstream can tell.
    if (!context.systemPromptPath) {
      throw new GateCommandError(
        `gate ${spec.gate} (${spec.agent.name}): print mode needs systemPromptPath. ` +
          'Without it the gate would answer as a generic assistant while the run ' +
          'records the agent that never saw it.',
      );
    }
    // The agent's own body and grant, rather than --agent: that flag
    // suppresses structured_output, and a reading gate exists to produce a
    // verdict. Both values come from the agent file in the pinned harness.
    argv.push('--append-system-prompt-file', context.systemPromptPath);
    argv.push('--tools', spec.agent.tools.join(','));
    argv.push('--print', '--output-format', 'json');
    if (spec.schema) argv.push('--json-schema', JSON.stringify(spec.schema));
    // Last, and non-variadic on purpose — see the header. Nothing positional
    // follows in print mode anyway, because the prompt goes on stdin.
    argv.push('--session-id', context.sessionId);
    return { argv, stdin: prompt, cwd: context.cwd, env: gateEnv(context) };
  }

  // Background mode takes the prompt as a POSITIONAL, so the flag immediately
  // before it must not be variadic or the prompt is swallowed as its value.
  // `--session-id` takes exactly one argument, which is why it goes last.
  // --agent here, because a background gate cannot return structured output
  // anyway (its verdict is the receipt file) and letting the plugin resolve
  // the agent keeps its composition, hooks and grant intact.
  argv.push('--agent', spec.agent.name);
  argv.push('--bg');
  argv.push('--session-id', context.sessionId);
  argv.push(prompt);
  return { argv, stdin: null, cwd: context.cwd, env: gateEnv(context) };
}
