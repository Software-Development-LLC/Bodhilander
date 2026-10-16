/**
 * The four tools Claude Desktop sees, each a thin mapping onto routes the
 * local API already serves. Nothing here reaches the shell directly.
 */
import type { Group, Session } from '../shared/types';
import { KnownRepo, knownRepos, normalizeRepoPath, pathApi } from '../shared/known-repos';
import type { PersistedChatEvent } from '../main/api/chat-parser/types';
import { ApiClient, ToolError } from './api-client';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  api: ApiClient;
  platform: NodeJS.Platform;
  dirExists: (dir: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** How long a new session gets to reach its prompt before the prompt is typed. */
  readyTimeoutMs: number;
  pollMs: number;
  /** Claude Code paints its prompt after the first idle tick, so the earliest read is not trusted. */
  settleMs: number;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_sessions',
    description:
      'List the Claude Code and shell sessions in Bodhilander, with each one\'s id, name, repo directory, ' +
      'group, Claude account and status (idle, working, waiting, error or stopped).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_session',
    description:
      'Read one Bodhilander session: its status plus its most recent chat events (assistant text, tool calls, ' +
      'prompts and errors), oldest first. Use list_sessions to find the id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id from list_sessions.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many recent events to return (default 20).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_session',
    description:
      'Start a new Claude Code session in Bodhilander in one of the repos Bodhilander already knows, and send it ' +
      'a prompt. The session appears in the Bodhilander window. Use read_session to follow its progress.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'A repo Bodhilander knows: its folder name, its group name, or its full path.',
        },
        prompt: { type: 'string', description: 'The task to give Claude Code.' },
        agent: { type: 'string', description: 'Optional subagent to hand the task to, e.g. "code-reviewer".' },
        name: { type: 'string', description: 'Optional session name shown in Bodhilander.' },
      },
      required: ['repo', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_status',
    description:
      "Read-only status of a Bodhilander run-engine initiative: the run's state, each repo's gate progress, " +
      'and its pull request links.',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'string', description: 'The initiative key, e.g. "BDHLNDR-401", or just its number, e.g. "401".' },
      },
      required: ['issue'],
      additionalProperties: false,
    },
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INITIATIVE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const ISSUE_NUMBER = /^#?(\d{1,9})$/;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/;
const EVENT_TEXT_MAX = 2000;
const READ_OUTPUT_MAX = 40_000;
const PROMPT_MAX = 50_000;
const TRUST_DIALOG = /trust (the files|this folder)|Do you trust/i;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const PROMPT_LEAD = 'Task from Claude Desktop:\n\n';

function stringArg(args: Record<string, unknown>, key: string, required: true): string;
function stringArg(args: Record<string, unknown>, key: string, required: false): string | undefined;
function stringArg(args: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw new ToolError(`"${key}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`);
  return value.trim();
}

function trim(text: string, max = EVENT_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

async function listSessions(ctx: ToolContext): Promise<unknown> {
  const [{ sessions }, { groups }] = await Promise.all([
    ctx.api.get<{ sessions: Session[] }>('/sessions'),
    ctx.api.get<{ groups: Group[] }>('/groups'),
  ]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  return {
    sessions: sessions.map((s) => {
      const group = byId.get(s.groupId);
      return {
        id: s.id,
        name: s.name,
        repo: s.workingDir,
        group: group?.name ?? null,
        account: s.claudeAccountId ?? group?.claudeAccountId ?? 'default',
        status: s.state,
        kind: s.shellType === 'claude' ? s.provider : 'shell',
      };
    }),
  };
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function eventText(event: PersistedChatEvent): string {
  const p = event.payload as Record<string, unknown>;
  if (event.type === 'tool_call') return `${asText(p.tool)} ${asText(p.argsBrief)}`.trim();
  if (event.type === 'prompt_options') {
    const options = Array.isArray(p.options) ? p.options as { key: string; label: string }[] : [];
    const choices = options.map((o) => '[' + asText(o.key) + '] ' + asText(o.label)).join(' ');
    return `${asText(p.question)} ${choices}`.trim();
  }
  if (event.type === 'prompt_yes_no') return asText(p.question);
  return asText(p.text);
}

/** Newest events win when the whole page would be too large to hand back. */
function fitEvents(events: { type: string; at: string; text: string }[]) {
  const kept: typeof events = [];
  let size = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    size += events[i].text.length + 64;
    if (size > READ_OUTPUT_MAX) break;
    kept.unshift(events[i]);
  }
  return { events: kept, omitted: events.length - kept.length };
}

async function readSession(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const id = stringArg(args, 'id', true);
  if (!UUID.test(id)) throw new ToolError(`"${id}" is not a session id. Use list_sessions to find one.`);
  const rawLimit = args.limit ?? 20;
  if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) {
    throw new ToolError('"limit" must be a positive integer.');
  }
  const limit = Math.min(rawLimit, 100);
  const { session } = await ctx.api.get<{ session: Session }>(`/sessions/${id}`);
  const { events } = await ctx.api.get<{ events: PersistedChatEvent[] }>(`/sessions/${id}/chat-events?limit=${limit}`);
  const fitted = fitEvents(events.map((e) => ({
    type: e.type,
    at: new Date(e.timestamp).toISOString(),
    text: trim(eventText(e)),
  })));
  return {
    session: { id: session.id, name: session.name, repo: session.workingDir, status: session.state },
    ...fitted,
  };
}

export function resolveRepo(
  repo: string,
  groups: Group[],
  sessions: Session[],
  platform: NodeJS.Platform,
): KnownRepo {
  const known = knownRepos(groups, sessions, platform);
  const p = pathApi(platform);
  const wanted = repo.toLowerCase();
  const matches = /[\\/]/.test(repo)
    ? known.filter((k) => normalizeRepoPath(k.dir, platform) === normalizeRepoPath(repo, platform))
    : known.filter((k) => p.basename(k.dir).toLowerCase() === wanted || k.groupName?.toLowerCase() === wanted);
  if (matches.length === 1) return matches[0];
  const listing = (matches.length > 1 ? matches : known).slice(0, 20).map((k) => k.dir).join(', ');
  if (matches.length > 1) throw new ToolError(`"${repo}" matches several repos; pass the full path: ${listing}`);
  throw new ToolError(
    `"${repo}" is not a repo Bodhilander knows. Sessions can only start in a known repo` +
      (listing ? `: ${listing}` : '; add one to a group in Bodhilander first.'),
  );
}

/** Typed text cannot carry escape sequences, so it cannot end the paste early or drive the terminal. */
export function sanitizePrompt(prompt: string): string {
  return prompt
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/**
 * What is pasted into Claude Code. The fixed first line means the caller's
 * text never starts the input, where `!` would run a shell command and `/` a
 * slash command.
 */
export function composePrompt(prompt: string, agent?: string): string {
  const handoff = agent ? `Use the ${agent} subagent for this task.\n\n` : '';
  return `${PROMPT_LEAD}${handoff}${prompt}`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/**
 * Claude Code's input box: its permission-mode footer, or its `❯` marker. At
 * full width the rule above the input fills the line, so the terminal emits
 * no newline and the marker follows the rule directly.
 */
export function showsInputBox(screen: string): boolean {
  if (screen.includes(' mode on')) return true;
  return /(^|─)[>❯]\s/m.test(screen);
}

type Readiness = { ready: true } | { ready: false; reason: string };

/**
 * A new session reads 'idle' before anything has run, so idle alone proves
 * nothing. Ready means the state has moved since creation and Claude Code's
 * input box is on screen.
 */
async function waitForPrompt(ctx: ToolContext, id: string): Promise<Readiness> {
  const started = ctx.now();
  await ctx.sleep(ctx.settleMs);
  for (;;) {
    const { session } = await ctx.api.get<{ session: Session }>(`/sessions/${id}`);
    if (session.state === 'error' || session.state === 'stopped') {
      return { ready: false, reason: `the session ${session.state === 'error' ? 'hit an error' : 'stopped'} while starting` };
    }
    const moved = new Date(session.lastActivityAt).getTime() > new Date(session.createdAt).getTime();
    if (moved && (session.state === 'idle' || session.state === 'waiting')) {
      const { buffer } = await ctx.api.get<{ buffer: string }>(`/terminal/${id}/buffer`);
      const screen = buffer.slice(-4000).replace(ANSI, '');
      if (TRUST_DIALOG.test(screen)) {
        return { ready: false, reason: 'Claude Code is asking whether to trust this folder; answer it in Bodhilander' };
      }
      if (session.state === 'waiting') {
        return { ready: false, reason: 'Claude Code is waiting on a question; answer it in Bodhilander' };
      }
      if (showsInputBox(screen)) return { ready: true };
    }
    if (ctx.now() - started >= ctx.readyTimeoutMs) {
      return { ready: false, reason: `Claude Code was not ready within ${Math.round(ctx.readyTimeoutMs / 1000)}s` };
    }
    await ctx.sleep(ctx.pollMs);
  }
}

async function startSession(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const repo = stringArg(args, 'repo', true);
  const prompt = sanitizePrompt(stringArg(args, 'prompt', true));
  const agent = stringArg(args, 'agent', false);
  const name = stringArg(args, 'name', false);
  if (prompt.length > PROMPT_MAX) throw new ToolError(`"prompt" is longer than ${PROMPT_MAX} characters.`);
  if (agent !== undefined && !AGENT_NAME.test(agent)) throw new ToolError(`"${agent}" is not a valid agent name.`);
  if (name !== undefined && name.length > 200) throw new ToolError('"name" is longer than 200 characters.');

  const [{ sessions }, { groups }] = await Promise.all([
    ctx.api.get<{ sessions: Session[] }>('/sessions'),
    ctx.api.get<{ groups: Group[] }>('/groups'),
  ]);
  const target = resolveRepo(repo, groups, sessions, ctx.platform);
  if (!ctx.dirExists(target.dir)) throw new ToolError(`${target.dir} no longer exists on this machine.`);

  const { session } = await ctx.api.post<{ session: Session }>('/sessions', {
    groupId: target.groupId,
    name: name ?? `Claude Desktop: ${pathApi(ctx.platform).basename(target.dir)}`,
    workingDir: target.dir,
    launchClaude: true,
  });

  const readiness = await waitForPrompt(ctx, session.id);
  const summary = { id: session.id, name: session.name, repo: target.dir };
  if (!readiness.ready) {
    return { session: summary, promptDelivered: false, reason: `${readiness.reason}. The prompt was not sent.` };
  }
  const text = composePrompt(prompt, agent);
  await ctx.api.post(`/terminal/${session.id}/input`, { data: `${PASTE_START}${text}${PASTE_END}` });
  // Enter arrives as its own keystroke; inside the paste it would be a newline.
  await ctx.sleep(300);
  await ctx.api.post(`/terminal/${session.id}/input`, { data: '\r' });
  return { session: summary, promptDelivered: true };
}

async function runStatus(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const issue = stringArg(args, 'issue', true);
  const number = ISSUE_NUMBER.exec(issue);
  if (number) return ctx.api.get(`/runs/${number[1]}/status`);
  if (!INITIATIVE_KEY.test(issue)) {
    throw new ToolError(`"${issue}" is not an initiative key. Pass it as "BDHLNDR-401", "401" or "#401".`);
  }
  return ctx.api.get(`/runs/${encodeURIComponent(issue)}/status`);
}

const HANDLERS: Record<string, (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>> = {
  list_sessions: listSessions,
  read_session: readSession,
  start_session: startSession,
  run_status: runStatus,
};

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  try {
    const result = await handler(ctx, input);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ToolError) return err.message;
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}
