/**
 * Where a gate's permission prompt goes when nobody is sitting at it (CO-722).
 *
 * A background gate cannot be asked anything. `--permission-prompts host`
 * routes prompts to a host session, and a `--bg` gate has no host with a
 * person attached, so the first tool needing approval waits for an answer
 * that never comes -- measured on the first real gate launch, which sat on a
 * `Bash` call for twenty minutes without burning a token.
 *
 * The CLI's answer to this is `--permission-prompt-tool`, which hands each
 * request to an MCP tool instead of to a terminal. That turns "a person must
 * be present" into "a person must eventually reply", and eventually is
 * something an inbox can serve.
 *
 * ## The channel is a directory
 *
 * Not a socket and not a table. A request is a file, an answer is a file
 * beside it, and the broker that serves the MCP tool is a plain node process
 * that can read neither this module nor the database -- `better-sqlite3` is
 * built for Electron's ABI, so a child process could not open the store even
 * if it wanted to. Files also mean a stuck gate can be read by a person with
 * `cat`, which matters for the pain this whole engine exists to address.
 *
 *   <dir>/<toolUseId>.request.json   written by the broker, read here
 *   <dir>/<toolUseId>.reply.json     written here, read by the broker
 *
 * ## What this module is and is not
 *
 * It decides what the files mean. It does not read them, write them, or wait
 * for them: the caller supplies what it found and performs what this returns,
 * which is what makes every case below an assertion rather than a fixture on
 * disk.
 *
 * ## Measured against the CLI, not assumed (2.1.270)
 *
 * `--permission-prompt-tool` is a real flag though it has no entry of its own
 * in `--help`; it appears only inside the description of
 * `--permission-prompts`. Unknown flags do error, and this one does not, which
 * is how that was established rather than inferred from the text.
 *
 * The tool is invoked as an ordinary `tools/call` with arguments
 * `{ tool_name, input, tool_use_id }`, and the reply is read out of the
 * content text as JSON. `{"behavior":"allow"}` grants, `{"behavior":"deny"}`
 * refuses, and a `message` on a denial reaches the model rather than being
 * swallowed. A reply delayed 120 seconds was honoured in full, so holding a
 * request open while a person decides is the supported shape and not an abuse
 * of one.
 */

/** What the broker recorded when the gate asked. */
export interface PermissionRequest {
  /** The CLI's own id for the tool call. Names both files. */
  toolUseId: string;
  /** `Bash`, `Edit`, and so on. What a person is actually approving. */
  toolName: string;
  /**
   * The tool's input, verbatim.
   *
   * Kept whole rather than summarised: a person approving a `Bash` call is
   * approving its command line, and a channel that showed them a shortened
   * version would be asking them to agree to something they had not read.
   */
  input: unknown;
  /** ISO 8601, from the broker. */
  askedAt: string;
}

/** What a person decided. */
export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

/**
 * A request file that could not be understood.
 *
 * Its own case rather than a silent skip. The gate is blocked on this id
 * whatever the file says, so dropping it would hang the run on something no
 * screen would ever show -- the exact failure this channel exists to end.
 */
export interface UnreadableRequest {
  toolUseId: string;
  reason: string;
}

export interface ChannelReading {
  /** Asked, and not yet answered. These are what a person has to look at. */
  pending: PermissionRequest[];
  /** Asked, and unreadable. Also a person's problem, for a different reason. */
  unreadable: UnreadableRequest[];
}

/** One file the caller found in the channel directory. */
export interface ChannelFile {
  name: string;
  /** Null when the file could not be read at all. */
  text: string | null;
}

const REQUEST_SUFFIX = '.request.json';
const REPLY_SUFFIX = '.reply.json';

/**
 * The MCP name the gate is told to ask.
 *
 * `mcp__<server>__<tool>`, where the server half is the key in the config
 * below. The two are written together here because a mismatch between them
 * fails in the worst possible way: the flag is accepted, no server answers,
 * and the gate blocks exactly as it did before the channel existed.
 */
export const PERMISSION_TOOL = 'mcp__bodhi_permissions__ask';

/**
 * Where one gate's requests live.
 *
 * The key is the caller's, deliberately. This module has no way to know what
 * a given caller can look up later, and guessing wrong is not a small error:
 * a channel nobody can find again is a gate nobody can unblock. The one rule
 * is that a retry must not collide with the attempt it is retrying, or a
 * stale request would read as the new one's.
 */
export function channelDirFor(root: string, channelKey: string): string {
  return `${root}/${channelKey}`;
}

/**
 * The `--mcp-config` the gate is launched with.
 *
 * Returned as text rather than written, so the composition is assertable. The
 * server key must match {@link PERMISSION_TOOL}'s middle segment.
 */
export function mcpConfigText(brokerPath: string, channelDir: string): string {
  return JSON.stringify(
    { mcpServers: { bodhi_permissions: { command: 'node', args: [brokerPath, channelDir] } } },
    null,
    2,
  );
}

/**
 * How long a background gate's hook may hold a request, in seconds.
 *
 * Measured against claude 2.1.270: a hook configured with 3600 held a
 * decision for 70s and was honoured; 900 held one for 150s. Whether the CLI
 * caps it higher is not known, which is why the broker keeps its own
 * deadline INSIDE this one -- see {@link hookSettingsText}.
 */
export const HOOK_TIMEOUT_SECONDS = 3600;

/**
 * The broker's own deadline, strictly inside the hook's.
 *
 * A hook the CLI kills does not deny and does not allow: the tool call falls
 * through to an interactive prompt, and a background gate has nobody at it.
 * Measured -- the session sat on that prompt with the file unwritten. So the
 * broker must answer before the CLI stops waiting, and when it does so
 * because nobody replied, it says exactly that, so the gate ends with a
 * reason a person can read rather than a hang nobody can see.
 */
export const HOOK_ANSWER_BY_SECONDS = HOOK_TIMEOUT_SECONDS - 300;

/**
 * The `--settings` a background gate is launched with.
 *
 * `--permission-prompt-tool` is not consulted for a `--bg` gate; a
 * `PreToolUse` hook is (#291). The hook runs the same broker in hook mode,
 * on the same channel directory, filing requests in the same shape -- so the
 * reader, the console and the inbox do not know which route a request took.
 *
 * Every tool is matched. The CLI decides which calls need permission and only
 * invokes the hook for those; matching narrowly here would be this module
 * holding an opinion about what is dangerous, which is not its to hold.
 */
export function hookSettingsText(brokerPath: string, channelDir: string): string {
  const command = `node "${brokerPath}" --hook "${channelDir}" ${HOOK_ANSWER_BY_SECONDS}`;
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] }],
      },
    },
    null,
    2,
  );
}

/** The file the broker waits on, for a decision a person made. */
export function replyFileName(toolUseId: string): string {
  return `${toolUseId}${REPLY_SUFFIX}`;
}

/** The file the broker writes when a gate asks. */
export function requestFileName(toolUseId: string): string {
  return `${toolUseId}${REQUEST_SUFFIX}`;
}

/**
 * Serialise a decision for the broker.
 *
 * `deny` carries a message because the CLI passes it to the model, which is
 * the difference between a gate that knows it was refused and one that only
 * knows it failed. A refusal with nothing in it teaches an owner to retry.
 */
export function encodeDecision(decision: PermissionDecision): string {
  return JSON.stringify(decision);
}

function parseRequest(toolUseId: string, text: string): PermissionRequest | UnreadableRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { toolUseId, reason: 'the request file is not JSON' };
  }
  // `Array.isArray` as well as the null check, because `typeof [] === 'object'`
  // and an array would otherwise fall through to "names no tool" -- a true
  // statement that sends the reader looking for a missing field rather than
  // at a file that is the wrong shape entirely.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { toolUseId, reason: 'the request file is not an object' };
  }
  const record = parsed as Record<string, unknown>;
  const toolName = record.toolName;
  const askedAt = record.askedAt;
  if (typeof toolName !== 'string' || toolName === '') {
    return { toolUseId, reason: 'the request names no tool' };
  }
  if (typeof askedAt !== 'string' || askedAt === '') {
    return { toolUseId, reason: 'the request says when nothing was asked' };
  }
  // `input` is deliberately not type-checked beyond existing. Every tool has
  // its own shape and this module must not learn any of them -- it is the
  // person reading it who decides whether the input is acceptable.
  if (!('input' in record)) {
    return { toolUseId, reason: 'the request carries no tool input' };
  }
  return { toolUseId, toolName, input: record.input, askedAt };
}

/**
 * What the channel currently holds.
 *
 * A request with a reply beside it is finished -- the broker has its answer,
 * or is about to -- so it is neither pending nor a person's problem.
 *
 * Files that are neither requests nor replies are ignored rather than
 * reported. The directory is the engine's own, but a stray editor backup must
 * not be able to park a run.
 */
export function readChannel(files: readonly ChannelFile[]): ChannelReading {
  const answered = new Set<string>();
  for (const file of files) {
    if (file.name.endsWith(REPLY_SUFFIX)) {
      answered.add(file.name.slice(0, -REPLY_SUFFIX.length));
    }
  }

  const pending: PermissionRequest[] = [];
  const unreadable: UnreadableRequest[] = [];
  for (const file of files) {
    if (!file.name.endsWith(REQUEST_SUFFIX)) continue;
    const toolUseId = file.name.slice(0, -REQUEST_SUFFIX.length);
    if (toolUseId === '' || answered.has(toolUseId)) continue;
    if (file.text === null) {
      unreadable.push({ toolUseId, reason: 'the request file could not be read' });
      continue;
    }
    const parsed = parseRequest(toolUseId, file.text);
    if ('reason' in parsed) unreadable.push(parsed);
    else pending.push(parsed);
  }

  // Oldest first, so the thing that has blocked the gate longest is the thing
  // a person is shown first. Ties fall back to the id so the order is stable
  // between reads rather than dependent on how the directory was listed.
  pending.sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.toolUseId.localeCompare(b.toolUseId));
  unreadable.sort((a, b) => a.toolUseId.localeCompare(b.toolUseId));
  return { pending, unreadable };
}

/**
 * Whether a reading should move the run.
 *
 * Anything unanswered parks it, unreadable included: the gate is blocked
 * either way, and a state that said `running` while a request sat unread
 * would be the first pain again -- the engine claiming progress it is not
 * making.
 */
export function isWaiting(reading: ChannelReading): boolean {
  return reading.pending.length > 0 || reading.unreadable.length > 0;
}
