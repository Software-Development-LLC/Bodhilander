'use strict';
// The run's gh, in node: argv to the gateway socket with the run token, the answer back as gh's own.
const net = require('net');

const socketPath = process.env.CREW_GH_SOCKET;
const token = process.env.CREW_GH_TOKEN;
if (!socketPath || !token) {
  process.stderr.write('gh: this Crew run has no GitHub gateway\n');
  process.exit(1);
}
const conn = net.createConnection(socketPath);
let buffered = '';
conn.setEncoding('utf8');
conn.on('connect', () => conn.write(`${JSON.stringify({ token, args: process.argv.slice(2) })}\n`));
conn.on('data', (chunk) => { buffered += chunk; });
conn.on('end', () => {
  let answer;
  try {
    answer = JSON.parse(buffered);
  } catch {
    process.stderr.write('gh: the GitHub gateway gave no answer\n');
    process.exit(1);
  }
  process.stdout.write(answer.stdout || '');
  process.stderr.write(answer.stderr || '');
  process.exitCode = typeof answer.code === 'number' ? answer.code : 1;
});
conn.on('error', () => {
  process.stderr.write('gh: the GitHub gateway is not answering\n');
  process.exit(1);
});
