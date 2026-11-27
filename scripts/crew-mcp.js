/**
 * A Crew run's MCP relay: `node crew-mcp.js <approve|tools>`. It decides
 * nothing; each request goes to the main process over CREW_MCP_SOCKET,
 * with the run's token read once from descriptor 3.
 */
'use strict';

const fs = require('fs');
const net = require('net');

const TOKEN_FD = 3;

function readToken() {
  try {
    const value = fs.readFileSync(TOKEN_FD, 'utf8').trim();
    fs.closeSync(TOKEN_FD);
    return value;
  } catch {
    return '';
  }
}

const server = process.argv[2];
const socketPath = process.env.CREW_MCP_SOCKET;
const token = readToken();
if (!server || !socketPath || !token) {
  process.stderr.write('crew-mcp: a server name, CREW_MCP_SOCKET and the token on descriptor 3 are required\n');
  process.exit(2);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function ask(request) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    let buffered = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify({ token, server, ...request })}\n`));
    conn.on('data', (chunk) => { buffered += chunk; });
    conn.on('end', () => {
      try {
        resolve(JSON.parse(buffered));
      } catch {
        resolve({ ok: false, error: 'unreadable answer' });
      }
    });
    conn.on('error', () => resolve({ ok: false, error: 'Bodhilander is not answering' }));
  });
}

async function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: `crew-${server}`, version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    const answer = await ask({ op: 'list' });
    send({ jsonrpc: '2.0', id: message.id, result: { tools: answer.ok ? answer.tools : [] } });
    return;
  }
  if (message.method === 'tools/call') {
    const params = message.params || {};
    const answer = await ask({ op: 'call', name: params.name, arguments: params.arguments || {} });
    const result = answer.ok ? answer.result : { content: [{ type: 'text', text: answer.error }], isError: true };
    send({ jsonrpc: '2.0', id: message.id, result });
    return;
  }
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
      continue;
    }
    void handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
