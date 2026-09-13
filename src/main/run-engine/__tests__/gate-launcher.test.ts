/**
 * Gate-launcher tests (CO-722).
 *
 * A real harness on disk, because what this module does is READ one — and the
 * whole point of reading rather than composing is that a copy in this repo
 * could drift from the file it copies. A fixture built from hand-written
 * strings in memory would be that copy, one layer up.
 *
 * The agent files here are shaped like the plugin's own, `gate:` lines
 * included, because the gate-to-role mapping is discovered from them: the
 * harness declares `arch: 1`, `reviewer: 3`, `verifier: 4`, `scribe: 0,4`,
 * and the owners in `agents/staff/` declare no gate at all.
 *
 * Run with: bun test src/main/run-engine
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GateLaunchError, agentsForGate, loadAgent, launchGate } from '../gate-launcher';
import { GateCommandError } from '../gate-command';
import type { RunSpawnContext } from '../gate-command';

const made: string[] = [];

afterEach(async () => {
  // Unconditional: an assertion that throws would otherwise leave harnesses
  // behind every run.
  await Promise.all(made.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface FakeAgent {
  tools?: string;
  gate?: string;
  body?: string;
  staff?: boolean;
}

async function harness(agents: Record<string, FakeAgent>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-'));
  made.push(root);
  await fs.mkdir(path.join(root, 'agents', 'staff'), { recursive: true });
  for (const [name, agent] of Object.entries(agents)) {
    const front = [
      '---',
      `name: ${name}`,
      ...(agent.gate === undefined ? [] : [`gate: ${agent.gate}`]),
      `tools: ${agent.tools ?? 'Read, Bash, Grep, Glob'}`,
      '---',
      '',
    ].join('\n');
    const dir = agent.staff ? path.join(root, 'agents', 'staff') : path.join(root, 'agents');
    await fs.writeFile(path.join(dir, `${name}.md`), front + (agent.body ?? '# Purpose\n\nDo the thing.\n'));
  }
  return root;
}

const PLUGIN_SHAPED = {
  arch: { gate: '1' },
  reviewer: { gate: '3', tools: 'Read, Bash, Grep, Glob, TodoWrite' },
  verifier: { gate: '4' },
  scribe: { gate: '0,4', tools: 'Read, Write, Edit, Bash' },
  'product-owner': {},
  'bsa-lead': { staff: true, tools: 'Read, Write, Edit, Bash' },
};

describe('reading a role out of the harness', () => {
  test('an agent is found and its grant comes from its own file', async () => {
    const root = await harness(PLUGIN_SHAPED);
    const agent = await loadAgent(root, 'reviewer');
    expect(agent.tools).toEqual(['Read', 'Bash', 'Grep', 'Glob', 'TodoWrite']);
    expect(agent.body).toContain('# Purpose');
  });

  test('an owner is found in the staff folder', async () => {
    // Gate 2's role is a per-repo owner, and they live somewhere else.
    const root = await harness(PLUGIN_SHAPED);
    expect((await loadAgent(root, 'bsa-lead')).name).toBe('bsa-lead');
  });

  test('an agent that is not in THIS harness is refused, not searched for', async () => {
    // Three copies of the plugin were reachable in one 18-hour window.
    // "Find it somewhere" is how a gate runs a role nobody pinned.
    const root = await harness(PLUGIN_SHAPED);
    await expect(loadAgent(root, 'nonesuch')).rejects.toBeInstanceOf(GateLaunchError);
  });

  test('the refusal names where it looked', async () => {
    const root = await harness(PLUGIN_SHAPED);
    const error = await loadAgent(root, 'nonesuch').catch((e: Error) => e);
    expect(error.message).toContain('agents');
    expect(error.message).toContain('staff');
  });

  test('an agent with no tools is refused rather than granted everything', async () => {
    // Inherited from parseAgentFile, asserted here because this is the path
    // that actually reads files: a grant that fell back to "everything" is a
    // reviewer that can rewrite the branch it is reviewing.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-'));
    made.push(root);
    await fs.mkdir(path.join(root, 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'agents', 'broken.md'),
      '---\nname: broken\ngate: 3\n---\n\n# Purpose\n',
    );
    await expect(loadAgent(root, 'broken')).rejects.toThrow(/tools/);
  });
});

describe('which role serves which gate is discovered, not hardcoded', () => {
  test('the harness names gate 3’s agent', async () => {
    const root = await harness(PLUGIN_SHAPED);
    expect(await agentsForGate(root, 3)).toEqual(['reviewer']);
  });

  test('a gate with two agents returns both', async () => {
    // Gate 4 is verifier then scribe. WHICH ORDER is the engine's business —
    // that is sequencing — but WHO is the harness's.
    const root = await harness(PLUGIN_SHAPED);
    expect(await agentsForGate(root, 4)).toEqual(['scribe', 'verifier']);
  });

  test('a multi-gate declaration counts for each gate it names', async () => {
    // scribe declares `gate: 0,4` and serves both.
    const root = await harness(PLUGIN_SHAPED);
    expect(await agentsForGate(root, 4)).toContain('scribe');
  });

  test('an agent declaring no gate is not a gate’s agent', async () => {
    // The owners in staff/ are chosen per repo, not per gate. Returning them
    // here would have gate 2 pick a role by position out of forty.
    const root = await harness(PLUGIN_SHAPED);
    for (const gate of [2, 3, 4] as const) {
      expect(await agentsForGate(root, gate)).not.toContain('bsa-lead');
      expect(await agentsForGate(root, gate)).not.toContain('product-owner');
    }
  });

  test('a gate nothing declares returns nothing, rather than guessing', async () => {
    const root = await harness(PLUGIN_SHAPED);
    expect(await agentsForGate(root, 2)).toEqual([]);
  });

  test('a substring is not a match', async () => {
    // `gate: 14` must not answer for gate 4, and `gate: 40` must not either.
    const root = await harness({ odd: { gate: '14,40' } });
    expect(await agentsForGate(root, 4)).toEqual([]);
    expect(await agentsForGate(root, 1)).toEqual([]);
  });

  test('a harness with no agents at all does not throw', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-'));
    made.push(root);
    expect(await agentsForGate(root, 3)).toEqual([]);
  });
});

describe('launching', () => {
  function context(harnessPath: string): Omit<RunSpawnContext, 'systemPromptPath'> {
    return {
      harnessPath,
      bodhiRoot: 'C:/work/repos',
      cwd: 'C:/work/repos/_wt-demo',
      pythonPath: 'C:/py/python.exe',
      posture: 'manual',
      sessionId: '11111111-2222-3333-4444-555555555555',
    };
  }

  async function launch(root: string, over: Partial<Parameters<typeof launchGate>[0]> = {}) {
    const promptFileDir = path.join(root, 'prompts');
    return launchGate({
      gate: 3,
      agentName: 'reviewer',
      mode: 'print',
      prompt: 'review the diff',
      promptFileDir,
      context: context(root),
      // A node that answers the envelope, so the launch runs end to end
      // without a claude on the machine.
      spawn: {
        executable: process.execPath,
        timeoutMs: 20_000,
      },
      ...over,
    });
  }

  test('print mode writes the role to disk before it builds the command', async () => {
    // The file is not a nicety: reviewer.md is 37,429 characters, and inline
    // that exceeds Windows' command line — ENAMETOOLONG, raised before the
    // process starts.
    const root = await harness(PLUGIN_SHAPED);
    await launch(root).catch(() => undefined);
    const written = await fs.readdir(path.join(root, 'prompts'));
    expect(written).toEqual(['11111111-2222-3333-4444-555555555555-gate3.md']);
    const body = await fs.readFile(path.join(root, 'prompts', written[0]), 'utf8');
    expect(body).toContain('# Purpose');
    expect(body).not.toContain('tools:');
  });

  test('the file is named for the session, not the role', async () => {
    // Two gates in one run can share a role, and a shared file would be
    // rewritten under a gate still reading it.
    const root = await harness(PLUGIN_SHAPED);
    await launch(root, { gate: 4, agentName: 'verifier' }).catch(() => undefined);
    const written = await fs.readdir(path.join(root, 'prompts'));
    expect(written[0]).toContain('gate4');
  });

  test('a background gate writes no prompt file', async () => {
    // `--bg` resolves the agent itself through --plugin-dir, and writing a
    // file nothing reads leaves the role on disk for no reason.
    const root = await harness(PLUGIN_SHAPED);
    await launch(root, { mode: 'background', agentName: 'bsa-lead', gate: 2 }).catch(() => undefined);
    await expect(fs.readdir(path.join(root, 'prompts'))).rejects.toThrow();
  });

  test('a missing agent stops the launch before anything is spawned', async () => {
    const root = await harness(PLUGIN_SHAPED);
    await expect(launch(root, { agentName: 'nonesuch' })).rejects.toBeInstanceOf(GateLaunchError);
    await expect(fs.readdir(path.join(root, 'prompts'))).rejects.toThrow();
  });

  test('the outcome comes back from the process, not from the launcher', async () => {
    // End to end with node standing in for claude: the launcher's job ends at
    // handing over a command, and what came back is gate-process's reading.
    const root = await harness(PLUGIN_SHAPED);
    const outcome = await launch(root, {
      spawn: { executable: process.execPath, timeoutMs: 20_000 },
      prompt: 'unused',
    }).catch((e: Error) => e);
    // node is not claude: it is handed --plugin-dir and friends and exits
    // non-zero. What matters is that it was RUN and classified, not thrown.
    expect(outcome).not.toBeInstanceOf(Error);
    if (outcome instanceof Error) throw outcome;
    expect(outcome.status).toBe('undriveable');
  });
});

describe('what the builder refuses', () => {
  test('print mode without a role file is refused by the builder', async () => {
    // Asserted so the launcher's own guarantee is visible: it writes the file
    // BEFORE building, and this is what happens when something does not.
    // Without it the gate answers as a generic assistant while the run
    // records the agent that never saw it.
    const { buildGateCommand } = await import('../gate-command');
    expect(() =>
      buildGateCommand(
        { gate: 3, agent: { name: 'reviewer', tools: ['Read'], body: 'x' }, mode: 'print' },
        {
          harnessPath: '/plugins/bodhi',
          bodhiRoot: '/root',
          cwd: '/root/wt',
          posture: 'manual',
          sessionId: 'abc',
          systemPromptPath: null,
        },
        'prompt',
      ),
    ).toThrow(GateCommandError);
  });
});
