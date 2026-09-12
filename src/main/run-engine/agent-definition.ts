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
 * Parse an agent's markdown.
 *
 * Throws rather than defaulting. An agent whose `tools:` cannot be read must
 * not fall back to "everything" — that is the exact failure the plugin's CI
 * check exists to prevent, and inheriting it here would undo that check for
 * every gate this engine spawns.
 */
export function parseAgentFile(name: string, text: string): AgentDefinition {
  const match = FRONT_MATTER.exec(text);
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

  const tools = toolsLine
    .replace(/^tools:\s*/, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tools.length === 0) {
    throw new AgentParseError(`${name}: tools: is empty`);
  }

  const body = text.slice(match[0].length).trim();
  if (!body) {
    throw new AgentParseError(`${name}: front matter only, no role`);
  }

  return { name, tools, body };
}
