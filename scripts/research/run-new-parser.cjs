/**
 * Run the new ChatParser against the captured 5-min corpus and dump events.
 * One-off research script for BDHLNDR-72 — confirms the rewrite extracts
 * meaningful content from real Claude Code PTY output.
 */
const fs = require('fs');
const path = require('path');

// Use the compiled JS. Build first: bunx tsc -p tsconfig.main.json
const { ChatParser } = require(path.resolve(__dirname, '..', '..', 'dist', 'main', 'api', 'chat-parser', 'parser'));

const RAW = process.argv[2];
if (!RAW) { console.error('usage: run-new-parser.cjs <raw-file>'); process.exit(1); }
const raw = fs.readFileSync(RAW, 'utf8');

const events = [];
const parser = new ChatParser((evs) => events.push(...evs), { settleMs: 0 });

(async () => {
  // Feed in chunks to mimic real stream behaviour (settle harvests between
  // chunks). 4KB chunks roughly match what node-pty emits.
  const CHUNK = 4096;
  for (let i = 0; i < raw.length; i += CHUNK) {
    await parser.parse(raw.slice(i, i + CHUNK));
    await new Promise((r) => setTimeout(r, 1));
  }
  // Let any final settle fire
  await new Promise((r) => setTimeout(r, 10));
  parser.flush();
  parser.dispose();

  console.log(`total events: ${events.length}`);
  const byType = events.reduce((acc, e) => ((acc[e.type] = (acc[e.type] || 0) + 1), acc), {});
  console.log('by type:', byType);
  console.log();
  console.log('=== ALL EVENTS ===');
  for (const e of events) {
    const txt = (e.payload && (e.payload.text || e.payload.question)) || JSON.stringify(e.payload);
    console.log(`[${e.type}] (${txt.length}) ${JSON.stringify(String(txt).slice(0, 200))}`);
  }
})();
