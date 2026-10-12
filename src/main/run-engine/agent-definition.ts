/**
 * Reading a gate agent out of the pinned harness (CO-722).
 *
 * The plugin owns what an agent IS — its role, its rules, and the tool grant
 * in its front matter, which the plugin's own CI asserts is present:
 *
 *   "A missing `tools:` line silently grants an agent everything — including
 *    Skill and Agent. Not a lint preference: it is the difference between a
 *    reviewer that can only read and one that can rewrite the branch it is
 *    reviewing."
 *
 * So Bodhilander reads that file rather than restating any of it. Nothing here
 * knows what a reviewer looks for; it knows how to find the two fields the
 * command line needs.
 *
 * WHY NOT JUST `--agent`. Because `--agent` and `--json-schema` do not
 * compose: measured against 2.1.263, a run with `--agent bodhi:reviewer` and a
 * schema returns `subtype: success`, `is_error: false`, exit 0, and NO
 * `structured_output` — even when the agent completes the task. Passing the
 * same agent's body via `--append-system-prompt` with its own `tools:` returns
 * the validated object and the same restricted tool set. The reading gates
 * need a verdict, so they take that route; the owner gate keeps `--agent`,
 * which it can because its verdict comes from a receipt file.
 */

export interface AgentDefinition {
  /** Plugin-qualified name, for the modes that resolve it themselves. */
  name: string;
  /** The grant, exactly as the agent file declares it. Never composed here. */
  tools: readonly string[];
  /** Everything after the front matter: the role itself. */
  body: string;
}

export class AgentParseError extends Error {}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a `tools:` list on commas that separate entries.
 *
 * Not a plain `.split(',')`. A scoped grant carries its own commas inside
 * parentheses — `Bash(git add:*, git commit:*)` — and splitting naively turns
 * one correct entry into two malformed ones. Those would then be passed to
 * `--tools`, where a name that matches nothing grants nothing, so a gate would
 * quietly lose a capability its agent file had given it.
 *
 * None of the shipped agents uses that syntax yet. This is here so that
 * adopting it is a change in the plugin alone.
 */
function splitTools(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);

    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((t) => t.trim()).filter(Boolean);
}

/**
 * Parse an agent's markdown.
 *
 * Throws rather than defaulting. An agent whose `tools:` cannot be read must
 * not fall back to "everything" — that is the exact failure the plugin's CI
 * check exists to prevent, and inheriting it here would undo that check for
 * every gate this engine spawns.
 */
export function parseAgentFile(name: string, text: string): AgentDefinition {
  // A UTF-8 BOM ahead of `---` would make the front matter unfindable, and
  // this reads files from a Windows checkout where an editor can add one. The
  // failure would be "no front matter" on a file that plainly has it.
  const match = FRONT_MATTER.exec(text.replace(/^﻿/, ''));
  if (!match) {
    throw new AgentParseError(`${name}: no front matter, so no declared tools`);
  }

  const toolsLine = match[1]
    .split(/\r?\n/)
    .find((line) => /^tools:\s*/.test(line));
  if (!toolsLine) {
    throw new AgentParseError(
      `${name}: front matter declares no tools:, and defaulting would grant everything`,
    );
  }

  const tools = splitTools(toolsLine.replace(/^tools:\s*/, ''));
  if (tools.length === 0) {
    throw new AgentParseError(`${name}: tools: is empty`);
  }

  const body = text.slice(match[0].length).trim();
  if (!body) {
    throw new AgentParseError(`${name}: front matter only, no role`);
  }

  return { name, tools, body };
}
