#!/usr/bin/env node
/**
 * Capture raw Claude Code PTY output for parser fixture development
 * (BDHLNDR-71).
 *
 * Spawns `claude` under node-pty with a TTY-shaped environment so the output
 * is identical to what would flow through Bodhilander's ChatParser via
 * ptyManager. Every byte the PTY emits is mirrored to stdout AND appended
 * to an output file so you can interact normally while the capture happens
 * in the background.
 *
 * Usage:
 *   node scripts/capture-claude-pty.cjs [output-file] [-- args-for-claude...]
 *
 * Examples:
 *   node scripts/capture-claude-pty.cjs
 *     → writes to claude-capture-<timestamp>.txt in cwd
 *
 *   node scripts/capture-claude-pty.cjs fixtures/turn-with-tool-call.txt
 *     → writes to that exact path
 *
 *   node scripts/capture-claude-pty.cjs my-cap.txt -- --print "hello"
 *     → spawns `claude --print "hello"`, captures the entire turn,
 *       exits when claude exits
 *
 * After capture: drop the file into
 *   src/main/api/chat-parser/__tests__/fixtures/
 * and pair it with a `*.expected.json` reflecting what the parser SHOULD
 * produce (often easiest to start by recording what it currently DOES and
 * editing from there).
 */

const fs = require('fs');
const path = require('path');

// Resolve node-pty from the repo's node_modules.
const repoRoot = path.resolve(__dirname, '..');
const pty = require(path.join(repoRoot, 'node_modules', 'node-pty'));

// --- arg parsing -----------------------------------------------------------

const args = process.argv.slice(2);
const dashDashIdx = args.indexOf('--');
const ourArgs = dashDashIdx === -1 ? args : args.slice(0, dashDashIdx);
const claudeArgs = dashDashIdx === -1 ? [] : args.slice(dashDashIdx + 1);

const outFile =
  ourArgs[0] || path.join(process.cwd(), `claude-capture-${Date.now()}.txt`);
const absOut = path.resolve(outFile);
fs.mkdirSync(path.dirname(absOut), { recursive: true });

console.error(`[capture] writing PTY bytes to ${absOut}`);
console.error(`[capture] spawning: claude ${claudeArgs.join(' ')}`);
console.error('[capture] Ctrl-D (or Ctrl-C twice) to stop\n');

const out = fs.createWriteStream(absOut);

// --- spawn -----------------------------------------------------------------

const proc = pty.spawn('claude', claudeArgs, {
  name: 'xterm-256color',
  cols: process.stdout.columns || 100,
  rows: process.stdout.rows || 30,
  cwd: process.cwd(),
  env: process.env,
});

proc.onData((data) => {
  out.write(data);
  process.stdout.write(data);
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => proc.write(d));

process.stdout.on('resize', () => {
  proc.resize(process.stdout.columns || 100, process.stdout.rows || 30);
});

let ctrlCs = 0;
process.on('SIGINT', () => {
  ctrlCs += 1;
  if (ctrlCs >= 2) {
    proc.kill();
  }
});

proc.onExit(({ exitCode }) => {
  out.end(() => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    console.error(`\n[capture] saved ${fs.statSync(absOut).size} bytes to ${absOut}`);
    console.error(`[capture] claude exited with code ${exitCode}`);
    process.exit(exitCode);
  });
});
