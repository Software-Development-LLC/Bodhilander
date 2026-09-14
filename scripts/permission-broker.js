/**
 * The MCP server a blocked gate asks, and a person eventually answers (CO-722).
 *
 * A background gate cannot be prompted. `--permission-prompts host` sends
 * prompts to a host session, and a `--bg` gate has no host with a person at
 * it, so the first tool needing approval waits forever -- measured on the
 * first real gate launch, which sat on one `Bash` call for twenty minutes.
 *
 * `--permission-prompt-tool` hands each request to an MCP tool instead. This
 * is that tool. It does not decide anything: it writes the request down, waits
 * for a file to appear beside it, and returns whatever that file says.
 *
 *   <dir>/<toolUseId>.request.json   written here
 *   <dir>/<toolUseId>.reply.json     written by Bodhilander, read here
 *
 * ## Why plain node, and why files
 *
 * It cannot be part of the app. `better-sqlite3` is rebuilt for Electron's
 * ABI by postinstall, so a child process could not open the run store even if
 * it should -- and it should not. Files keep the two sides sharing nothing but
 * a directory, and leave a stuck gate readable with `cat`, which matters for
 * the pain this engine exists to address.
 *
 * ## It never answers on its own
 *
 * No timeout, no default. A broker that denied after a while would hand the
 * model a refusal nobody gave, and the gate would report a finding that came
 * from a clock. The run's own states already carry "waiting on a person"; the
 * only thing that ends the wait is a person.
 *
 * ## Measured against claude 2.1.270
 *
 * The tool is called as an ordinary `tools/call` with arguments
 * `{ tool_name, input, tool_use_id }`, and the decision is read out of the
 * content text as JSON: `{"behavior":"allow"}` grants, `{"behavior":"deny"}`
 * refuses, and `message` on a denial reaches the model. A reply held for 120
 * seconds was honoured in full, so waiting is the supported shape rather than
 * an abuse of one.
 *
 * Usage: node permission-broker.js <channel-dir>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const channelDir = process.argv[2];
if (!channelDir) {
  process.stderr.write('permission-broker: a channel directory is required\n');
  process.exit(2);
}
fs.mkdirSync(channelDir, { recursive: true });

/** How often to look for an answer. A person is not in a hurry. */
const POLL_MS = 500;

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

/**
 * Ask, then wait.
 *
 * The request is written whole -- the tool's input verbatim -- because a
 * person approving a Bash call is approving its command line, and an
 * approval given against a summary is not an approval of what runs.
 */
function ask(id, args) {
  const toolUseId = args.tool_use_id;
  if (typeof toolUseId !== 'string' || toolUseId === '') {
    // Without an id there are no two files to pair, so this cannot be routed
    // to anybody. Refusing beats hanging on a request nothing can answer.
    return reply(id, { behavior: 'deny', message: 'the permission request carried no tool_use_id' });
  }
  const requestPath = path.join(channelDir, `${toolUseId}.request.json`);
  const replyPath = path.join(channelDir, `${toolUseId}.reply.json`);

  // Rewriting on a repeat ask is deliberate: the id is the CLI's, so the same
  // id means the same question, and the freshest description of it wins.
  fs.writeFileSync(
    requestPath,
    JSON.stringify(
      { toolUseId, toolName: args.tool_name, input: args.input, askedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  const poll = setInterval(() => {
    let text;
    try {
      text = fs.readFileSync(replyPath, 'utf8');
    } catch {
      return; // Not answered yet. This is the normal case, most of the time.
    }
    let decision;
    try {
      decision = JSON.parse(text);
    } catch {
      // A half-written file is the likely cause and it will be complete on
      // the next tick, so this waits rather than treating it as an answer.
      return;
    }
    if (decision === null || typeof decision !== 'object' || !('behavior' in decision)) return;
    clearInterval(poll);
    reply(id, decision);
  }, POLL_MS);
  poll.unref?.();
}

function reply(id, decision) {
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'bodhi-permissions', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'ask',
            description: 'Route a permission request to the person who owns this run.',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
                tool_use_id: { type: 'string' },
              },
            },
          },
        ],
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    ask(message.id, (message.params && message.params.arguments) || {});
    return;
  }
  // Notifications carry no id and must not be answered; anything else with an
  // id gets an empty result rather than silence, which would wedge the client.
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: {} });
}

let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8');
  let cut;
  while ((cut = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, cut).trim();
    buffered = buffered.slice(cut + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // Not ours to interpret, and not worth dying over.
    }
    handle(message);
  }
});

// The gate closing its end is the only thing that ends this process. An
// unanswered request left behind is not tidied up: it is the record of what
// the gate was stopped on, and a person may still want to read it.
process.stdin.on('end', () => process.exit(0));
