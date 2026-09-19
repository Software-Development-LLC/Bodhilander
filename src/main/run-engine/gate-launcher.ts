/**
 * Getting a gate's agent out of the harness and onto a command line (CO-722).
 *
 * The executor owns what a launch MEANT; this owns how it happened, and the
 * split is deliberate — resolving a role must not be able to change what a
 * verdict means on its way past.
 *
 * Everything about the agent is READ from the pinned harness, never composed
 * here. The name, the grant and the role all come out of the agent's own
 * file, because a copy of any of them in this repo could drift from the file
 * it copies, and a drifted tool grant is a reviewer that can rewrite the
 * branch it is reviewing.
 *
 * That includes which agent serves which gate. The agent files declare it
 * themselves:
 *
 * ```
 * agents/arch.md       gate: 1
 * agents/reviewer.md   gate: 3
 * agents/verifier.md   gate: 4
 * agents/scribe.md     gate: 0,4
 * agents/staff/*.md    no gate — these are the owners, chosen per repo
 * ```
 *
 * So the mapping is discovered rather than hardcoded, and a plugin that moves
 * a role to a different gate moves it here too. What stays this side is
 * SEQUENCE — which of gate 4's two agents runs first is the engine's business
 * and nobody else's.
 *
 * Print mode needs the body on disk. The file is not a nicety: reviewer.md is
 * 37,429 characters, and passing that inline exceeds Windows' 32,767-character
 * command line — `ENAMETOOLONG: uv_spawn`, raised before the process starts.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Gate } from './transitions';
import { parseAgentFile, type AgentDefinition } from './agent-definition';
import { buildGateCommand, type GateMode, type RunSpawnContext } from './gate-command';
import { runGate, type GateOutcome, type GateSpawnOptions } from './gate-process';
import { GATE_VERDICT_SCHEMA } from './gate-verdict';
import { channelDirFor, hookSettingsText, mcpConfigText, PERMISSION_TOOL } from './permission-channel';
import { ensureDangerousModeAccepted } from '../claude-settings';

export class GateLaunchError extends Error {
  // Set explicitly: without it `error.name` reads "Error" in a log, and the
  // person triaging one has to already know which module raised it.
  name = 'GateLaunchError';
}

/** Where a role can live in the harness. Owners are in their own folder. */
const AGENT_DIRS = ['agents', path.join('agents', 'staff')];

/**
 * A role name that can only ever name a file inside the harness.
 *
 * The module's guarantee is that an agent not in the pinned harness is not an
 * agent this run may use, and a name is interpolated into a path — so without
 * this the guarantee rests on every caller passing something sensible. Names
 * come from `team.yaml` today, which a person writes, so "sensible" is a hope
 * rather than a property.
 *
 * Every real agent matches: arch, reviewer, scribe, verifier, product-owner,
 * bsa-lead, bma-care.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function agentFile(harnessPath: string, dir: string, name: string): string {
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    throw new GateLaunchError(
      `"${name}" is not a role name. A name is part of a path, so it may hold only `
        + 'letters, digits, dot, dash and underscore — never a separator or "..".',
    );
  }
  const base = path.resolve(harnessPath, dir);
  const file = path.resolve(base, `${name}.md`);
  // Belt and braces, and the belt is the one that holds: a pattern can be
  // out-argued by an encoding nobody thought of, while "is it under this
  // directory" is the question actually being asked.
  if (file !== path.join(base, `${name}.md`) || !file.startsWith(base + path.sep)) {
    throw new GateLaunchError(`"${name}" resolves outside the pinned harness`);
  }
  return file;
}

/**
 * Read one agent out of the harness by name.
 *
 * Refuses rather than searching further afield. An agent that is not in the
 * pinned harness is not an agent this run may use — three copies of this
 * plugin were reachable in one 18-hour window, and "find it somewhere" is how
 * a gate ends up running a role from a checkout nobody pinned.
 */
export async function loadAgent(
  harnessPath: string,
  name: string,
): Promise<AgentDefinition & { path: string }> {
  const tried: string[] = [];
  for (const dir of AGENT_DIRS) {
    const file = agentFile(harnessPath, dir, name);
    tried.push(file);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    return { ...parseAgentFile(name, text), path: file };
  }
  throw new GateLaunchError(
    `no agent named "${name}" in the pinned harness. Looked in:\n  ${tried.join('\n  ')}`,
  );
}

/** `gate: 4` and `gate: 0,4` both declare gate 4. */
function declaresGate(front: string, gate: number): boolean {
  return declared(front, 'gate')
    .split(',')
    .map((value) => value.trim())
    .includes(String(gate));
}

/**
 * Where in its gate an agent runs, or null if the harness does not say.
 *
 * Deliberately strict: anything that is not a run of digits is null rather
 * than coerced. `Number('')` is 0 and `parseInt('2nd')` is 2, and either
 * would turn a declaration nobody checked into a position this engine acted
 * on -- which is the whole failure the plugin's own invariants exist to
 * prevent, arriving through the reader instead.
 */
function gateOrder(front: string): number | null {
  const raw = declared(front, 'gate_order').trim();
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * Which agents the harness says serve this gate, by name, sorted.
 *
 * Sorted for determinism, NOT for sequence: gate 4 is verifier then scribe,
 * and that order is the engine's to know because it is sequencing rather than
 * judgment. Returning a stable list means a caller that picks by name gets
 * the same answer on every machine; returning it alphabetically means a
 * caller that picks by position gets a wrong one, loudly, on the first run.
 */
export async function agentsForGate(harnessPath: string, gate: Gate): Promise<string[]> {
  const agents = await eachAgent(harnessPath);
  return agents
    .filter((a) => declaresGate(a.front, gate))
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * One agent's claim on a gate, and where in that gate it runs.
 *
 * `order` is null when the harness declares no usable position for it. That
 * is a fact to report, not a default to invent -- see {@link HarnessRoles}.
 */
interface GateClaim {
  name: string;
  order: number | null;
}

/**
 * A gate the harness assigns more than one role.
 *
 * Not ambiguity, which is what several OWNERS for a repo means. Gate 4 is
 * verifier and then scribe, and BOTH run -- so this is a sequence, and the
 * order is part of what the gate means: the verifier judges whether green
 * proves anything, and only the scribe opens the PR carrying that evidence.
 * Reversed, the PR claims a verdict nobody reached.
 */
export interface GateSequence {
  gate: Gate;
  /**
   * In RUN order when this sequence came back ordered, and alphabetical when
   * it came back unordered -- which is why the two live in separate lists
   * rather than in one with a flag. A caller holding an `unordered` entry
   * must not be able to iterate it and believe it sequenced anything.
   */
  agents: string[];
}

export interface HarnessRoles {
  /** Gates exactly one agent declares. Safe to run as they are. */
  roles: Partial<Record<Gate, string>>;
  /**
   * Gates several agents serve, in the order the harness declares.
   *
   * The order is READ, never decided here. Which agent must precede which is
   * domain knowledge about what a gate means; running them in the declared
   * order is sequencing. An engine holding "verifier then scribe" would carry
   * a fact about a workflow that is free to change without it, and the two
   * would disagree silently because nothing compares them.
   */
  sequences: GateSequence[];
  /**
   * Gates several agents serve where no usable order was declared.
   *
   * A missing position, a tie, or a non-numeric one all land here. A tie is
   * not an order: it leaves the sequence to whatever the filesystem listed
   * first, which is how one initiative runs differently on two machines and
   * both report honestly.
   */
  unordered: GateSequence[];
  /** Gates nothing in this harness declares at all. */
  unclaimed: Gate[];
}

/**
 * Which role serves each gate, according to the harness rather than to us.
 *
 * Gate 2's role is the repo's owner and comes from the run; these are the
 * gates whose roles are a property of the pinned harness, so reading them
 * here is what keeps the engine from holding a mapping it would then have to
 * maintain against a plugin that changes without it.
 *
 * Every gate asked about gets an answer in exactly one of the three lists, so
 * a caller cannot silently skip one it did not think about.
 */
export async function rolesFromHarness(
  harnessPath: string,
  gates: readonly Gate[],
): Promise<HarnessRoles> {
  const agents = await eachAgent(harnessPath);
  const result: HarnessRoles = { roles: {}, sequences: [], unordered: [], unclaimed: [] };
  for (const gate of gates) {
    const claims: GateClaim[] = agents
      .filter((a) => declaresGate(a.front, gate))
      .map((a) => ({ name: a.name, order: gateOrder(a.front) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (claims.length === 0) {
      result.unclaimed.push(gate);
      continue;
    }
    if (claims.length === 1) {
      result.roles[gate] = claims[0].name;
      continue;
    }
    const ordered = sequence(claims);
    const names = (ordered ?? claims).map((claim) => claim.name);
    (ordered ? result.sequences : result.unordered).push({ gate, agents: names });
  }
  return result;
}

/**
 * The claims in run order, or null when the harness did not give one.
 *
 * Null for a missing position, a tie, or a non-numeric one. All three mean
 * the same thing to a caller -- nobody said what order to run these in -- and
 * inventing one would run half a gate in the wrong sequence and record it as
 * the whole thing.
 */
function sequence(claims: readonly GateClaim[]): GateClaim[] | null {
  const orders = claims.map((claim) => claim.order);
  if (orders.some((order) => order === null)) return null;
  if (new Set(orders).size !== orders.length) return null;
  return [...claims].sort((a, b) => (a.order as number) - (b.order as number));
}

/**
 * Where a gate's role is written for print mode.
 *
 * Named for the SESSION rather than the role: two gates in one run can share
 * a role, and a shared file would be rewritten under a gate that is still
 * reading it. Its own function so the naming can be asserted without racing
 * the cleanup that removes it.
 */
export function promptFilePath(dir: string, sessionId: string, gate: Gate): string {
  return path.join(dir, `${sessionId}-gate${gate}.md`);
}

/**
 * The front matter of an agent file, or null.
 *
 * One reader for both lookups below. The regex was written twice and the
 * second copy was wrong -- which is the ordinary fate of a duplicated
 * pattern, and the reason the BOM strip belongs here rather than in each.
 * A UTF-8 BOM ahead of `---` makes the front matter unfindable, and these
 * files come from a Windows checkout where an editor can add one.
 */
async function frontMatter(file: string): Promise<string | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^\ufeff/, ''));
  return match ? match[1] : null;
}

/** Every agent file in the harness, as (name, front matter). */
async function eachAgent(harnessPath: string): Promise<{ name: string; front: string }[]> {
  const out: { name: string; front: string }[] = [];
  for (const dir of AGENT_DIRS) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(harnessPath, dir));
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.endsWith('.md'))) {
      const front = await frontMatter(path.join(harnessPath, dir, entry));
      if (front !== null) out.push({ name: entry.replace(/\.md$/, ''), front });
    }
  }
  return out;
}

/** A front-matter value, trimmed, or ''. */
function declared(front: string, key: string): string {
  const line = front.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : '';
}

/**
 * Whether a front matter's `repo:` claims this repo.
 *
 * The key is not one name. Measured against the harness on disk:
 *
 *     repo: bodhi-service-api                                   one name
 *     repo: bodhi-service-api, bodhi-service-notify-v2, ...     a list
 *     repo: bodhi-provider-*, bodhi-service-connector*          globs
 *
 * Reading it as a single exact string -- which this did -- reported no owner
 * for bodhi-service-insights, which bsa-platform owns, and dropped
 * bsa-platform from bodhi-service-api's candidates. The second is the
 * dangerous one: FEWER candidates turns "several, ask a person" into "one,
 * decided", and the run picks an owner nobody chose.
 *
 * Only `*` is a wildcard, and every other metacharacter is escaped before
 * the pattern is built. The character class does that and is easy to get
 * wrong: it must escape both the `]` and the `\\` inside itself, or the class
 * closes early and the escape silently becomes a no-op -- which it did,
 * leaving a claim like `a.b-*` matching `aXb-x`.
 *
 * Anything else is matched literally, because a
 * `repo:` value is a repository name and treating a dot or a dash as a
 * pattern would let one agent claim repos it never named.
 */
function declaresRepo(front: string, repo: string): boolean {
  return declared(front, 'repo')
    .split(',')
    .map((claim) => claim.trim())
    .filter(Boolean)
    .some((claim) => {
      if (!claim.includes('*')) return claim === repo;
      const pattern = claim
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${pattern}$`).test(repo);
    });
}

/**
 * Which owners the harness says belong to a repo.
 *
 * Staff agents declare `repo:` in their front matter the same way gate agents
 * declare `gate:`, so this mapping is discovered too -- the engine never holds
 * a list of who owns what.
 *
 * Several agents can declare the same repo: a lead who owns what cuts across
 * it, and domain owners who own their own modules. Choosing between them is
 * judgment, so every candidate is returned and the choice is somebody else's.
 */
export async function agentsForRepo(harnessPath: string, repo: string): Promise<string[]> {
  const agents = await eachAgent(harnessPath);
  return agents
    .filter((a) => declaresRepo(a.front, repo))
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b));
}

export interface GateLaunch {
  gate: Gate;
  /** Which role. Read from the harness; for gate 2 it is the repo's owner. */
  agentName: string;
  mode: GateMode;
  prompt: string;
  /** Where the body is written for print mode. The caller owns the directory. */
  promptFileDir: string;
  context: Omit<RunSpawnContext, 'systemPromptPath' | 'permissionPromptTool' | 'mcpConfigPath' | 'settingsPath'>;
  spawn: GateSpawnOptions;
  /**
   * Where a gate that cannot be prompted sends its prompts.
   *
   * Omitted and the gate is launched exactly as before -- which for the
   * `manual` posture means it blocks on the first tool needing approval,
   * because `--permission-prompts host` has no host with a person at it.
   * That is #288, and it is the reason this is wired rather than optional in
   * spirit only.
   */
  permissions?: {
    /** Parent of the per-gate channel directories. The caller owns it. */
    root: string;
    /** `permission-broker.js`, absolute. Launched by the CLI, not by us. */
    brokerPath: string;
    /**
     * Names this gate's channel directory.
     *
     * Supplied rather than derived, because whoever has to find this again
     * to unblock the gate is the only one who knows what they can look up.
     * Must differ between attempts, or a retry inherits the stale request.
     */
    channelKey: string;
  };
}

/**
 * Resolve, write and run one gate.
 *
 * The system-prompt file is written before the command is built, because the
 * builder refuses print mode without one — and it is right to: without it the
 * gate answers as a generic assistant while the run records the agent that
 * never saw it. A schema-valid verdict from nobody is worse than no verdict,
 * because nothing downstream can tell.
 */
export async function launchGate(launch: GateLaunch): Promise<GateOutcome> {
  const agent = await loadAgent(launch.context.harnessPath, launch.agentName);

  // A `bypass` gate launches with `--dangerously-skip-permissions`, which the
  // CLI refuses on a config dir that has never accepted the one-time disclaimer
  // (a `--bg` gate exits 1). A managed account has never been through that
  // interactive accept, so seed the acceptance here -- idempotent, and only for
  // the posture that needs it, right before the launch that would fail without
  // it. Ambient login (no configDir) is left to the person's own acceptance.
  if (launch.context.posture === 'bypass' && launch.context.configDir) {
    ensureDangerousModeAccepted(launch.context.configDir);
  }

  // Only the posture that asks needs somewhere to ask. `bypass` prompts for
  // nothing and `denyOnPrompt` refuses without asking, so handing either a
  // channel would stand up a broker nobody will ever call.
  let permission: Pick<RunSpawnContext, 'permissionPromptTool' | 'mcpConfigPath' | 'settingsPath'> = {};
  if (launch.permissions && launch.context.posture === 'manual') {
    const channelDir = channelDirFor(launch.permissions.root, launch.permissions.channelKey);
    await fs.mkdir(channelDir, { recursive: true });
    if (launch.mode === 'background') {
      // `--permission-prompt-tool` is not consulted for a --bg gate: the
      // broker starts and is never asked (#291). A PreToolUse hook is, so a
      // background gate carries the same broker as a hook, on the same
      // channel, filing requests in the same shape.
      const settingsPath = `${channelDir}.settings.json`;
      await fs.writeFile(settingsPath, hookSettingsText(launch.permissions.brokerPath, channelDir), 'utf8');
      permission = { settingsPath };
    } else {
      const mcpConfigPath = `${channelDir}.mcp.json`;
      await fs.writeFile(mcpConfigPath, mcpConfigText(launch.permissions.brokerPath, channelDir), 'utf8');
      permission = { permissionPromptTool: PERMISSION_TOOL, mcpConfigPath };
    }
  }

  let systemPromptPath: string | null = null;
  if (launch.mode === 'print') {
    await fs.mkdir(launch.promptFileDir, { recursive: true });
    // Named for the session rather than the agent: two gates in one run can
    // share a role, and a shared file would be rewritten under a gate that
    // is still reading it.
    systemPromptPath = promptFilePath(launch.promptFileDir, launch.context.sessionId, launch.gate);
    await fs.writeFile(systemPromptPath, agent.body, 'utf8');
  }

  const command = buildGateCommand(
    {
      gate: launch.gate,
      agent,
      mode: launch.mode,
      // Only a reading gate is asked for a verdict. A background gate cannot
      // return structured output at all — `--bg` and `--print` conflict — and
      // its verdict comes from a receipt.
      schema: launch.mode === 'print' ? GATE_VERDICT_SCHEMA : undefined,
    },
    { ...launch.context, systemPromptPath, ...permission },
    launch.prompt,
  );

  try {
    return await runGate(command, launch.spawn);
  } finally {
    if (systemPromptPath) {
      // Removed once the gate has finished with it. The body is reproducible
      // from the harness at any moment, so keeping a copy per gate run is a
      // growing pile of duplicates of a file that already exists — and one
      // holding a role a later harness may have changed.
      //
      // A run interrupted before this leaves its file behind, which is why
      // the directory is the caller's: it can be swept on start.
      await fs.rm(systemPromptPath, { force: true }).catch(() => undefined);
    }
  }
}
