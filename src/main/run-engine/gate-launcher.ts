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

export class GateLaunchError extends Error {}

/** Where a role can live in the harness. Owners are in their own folder. */
const AGENT_DIRS = ['agents', path.join('agents', 'staff')];

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
    const file = path.join(harnessPath, dir, `${name}.md`);
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
function declaresGate(frontMatter: string, gate: number): boolean {
  const line = frontMatter.split(/\r?\n/).find((l) => /^gate:\s*/.test(l));
  if (!line) return false;
  return line
    .replace(/^gate:\s*/, '')
    .split(',')
    .map((value) => value.trim())
    .includes(String(gate));
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
  const found: string[] = [];
  for (const dir of AGENT_DIRS) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(harnessPath, dir));
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.endsWith('.md'))) {
      const file = path.join(harnessPath, dir, entry);
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ''));
      if (match && declaresGate(match[1], gate)) found.push(entry.replace(/\.md$/, ''));
    }
  }
  return found.sort();
}

export interface GateLaunch {
  gate: Gate;
  /** Which role. Read from the harness; for gate 2 it is the repo's owner. */
  agentName: string;
  mode: GateMode;
  prompt: string;
  /** Where the body is written for print mode. The caller owns the directory. */
  promptFileDir: string;
  context: Omit<RunSpawnContext, 'systemPromptPath'>;
  spawn: GateSpawnOptions;
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

  let systemPromptPath: string | null = null;
  if (launch.mode === 'print') {
    await fs.mkdir(launch.promptFileDir, { recursive: true });
    // Named for the session rather than the agent: two gates in one run can
    // share a role, and a shared file would be rewritten under a gate that
    // is still reading it.
    systemPromptPath = path.join(
      launch.promptFileDir,
      `${launch.context.sessionId}-gate${launch.gate}.md`,
    );
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
    { ...launch.context, systemPromptPath },
    launch.prompt,
  );

  return runGate(command, launch.spawn);
}
