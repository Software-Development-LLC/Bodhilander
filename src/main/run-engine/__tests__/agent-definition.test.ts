/**
 * Agent definition tests (CO-722).
 *
 * The grant this parser returns becomes `--tools` on a real gate, so the
 * cases that matter are the ones where it must REFUSE. A parser that shrugs
 * and returns a default hands the caller a reviewer that can rewrite the
 * branch it is reviewing — the exact failure the plugin's own CI check exists
 * to prevent, undone one layer down.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import { AgentParseError, parseAgentFile } from '../agent-definition';

const REAL = `---
name: reviewer
description: Adversarial review of a branch.
tools: Read, Bash, Grep, Glob, TodoWrite
---

# Reviewer

Walk the path a person takes.
`;

describe('reading a real agent', () => {
  test('takes the declared tools verbatim, in order', () => {
    expect(parseAgentFile('reviewer', REAL).tools)
      .toEqual(['Read', 'Bash', 'Grep', 'Glob', 'TodoWrite']);
  });

  test('the body is everything after the front matter', () => {
    const { body } = parseAgentFile('reviewer', REAL);
    expect(body.startsWith('# Reviewer')).toBe(true);
    expect(body).toContain('Walk the path a person takes.');
    // The front matter must not leak into a system prompt.
    expect(body).not.toContain('tools:');
    expect(body).not.toContain('---');
  });

  test('keeps the name it was asked for', () => {
    expect(parseAgentFile('bodhi:reviewer', REAL).name).toBe('bodhi:reviewer');
  });

  test('reads CRLF files, which is what a Windows checkout has', () => {
    const { tools, body } = parseAgentFile('reviewer', REAL.replace(/\n/g, '\r\n'));
    expect(tools).toEqual(['Read', 'Bash', 'Grep', 'Glob', 'TodoWrite']);
    expect(body).toContain('Walk the path');
  });

  test('tolerates spacing around the list', () => {
    const spaced = REAL.replace('tools: Read, Bash', 'tools:   Read ,Bash');
    expect(parseAgentFile('reviewer', spaced).tools.slice(0, 2)).toEqual(['Read', 'Bash']);
  });
});

describe('it refuses rather than defaulting', () => {
  test('no front matter at all', () => {
    expect(() => parseAgentFile('x', '# Just a heading\n')).toThrow(AgentParseError);
  });

  test('front matter with no tools: line', () => {
    // The plugin's CI says it plainly: a missing tools: line silently grants
    // everything, including Skill and Agent. Inheriting that default here
    // would undo that check for every gate this engine spawns.
    const noTools = '---\nname: x\ndescription: y\n---\n\nbody\n';
    expect(() => parseAgentFile('x', noTools)).toThrow(/declares no tools/);
  });

  test('an empty tools: list', () => {
    expect(() => parseAgentFile('x', '---\ntools:\n---\n\nbody\n')).toThrow(AgentParseError);
  });

  test('front matter but no role', () => {
    // An empty --append-system-prompt would run the gate as a generic
    // assistant while the run history claims a reviewer looked at it.
    expect(() => parseAgentFile('x', '---\ntools: Read\n---\n')).toThrow(/no role/);
  });

  test('the error names the agent, so a failed run says which one', () => {
    expect(() => parseAgentFile('bodhi:verifier', '# no front matter'))
      .toThrow(/bodhi:verifier/);
  });
});

describe('against the agents the plugin actually ships', () => {
  // Shapes taken from the real files, so a change to their front-matter
  // convention fails here rather than at spawn time.
  const shipped: Record<string, string> = {
    reviewer: 'tools: Read, Bash, Grep, Glob, TodoWrite',
    verifier: 'tools: Read, Bash, Grep, Glob, TodoWrite',
    scribe: 'tools: Read, Write, Edit, Bash, Grep, Glob, TodoWrite',
  };

  test('the reading gates carry no Write and no Edit', () => {
    for (const agent of ['reviewer', 'verifier']) {
      const parsed = parseAgentFile(agent, `---\n${shipped[agent]}\n---\n\nbody\n`);
      expect({ agent, write: parsed.tools.includes('Write') })
        .toEqual({ agent, write: false });
      expect({ agent, edit: parsed.tools.includes('Edit') })
        .toEqual({ agent, edit: false });
    }
  });

  test('scribe does carry them, because it writes the PR body', () => {
    // CONTROL: without this, a parser dropping every tool would satisfy the
    // assertion above while granting nothing to anyone.
    const parsed = parseAgentFile('scribe', `---\n${shipped.scribe}\n---\n\nbody\n`);
    expect(parsed.tools).toContain('Write');
    expect(parsed.tools).toContain('Edit');
  });
});
