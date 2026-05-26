/**
 * Research script for BDHLNDR-72: process the captured raw PTY corpus
 * with my (Python-equivalent) CR-discards logic to see what *real* lines
 * survive in the new parser's world.
 */
const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(process.argv[2]);
// CR-discards / LF-commits / ESC-skip
const lines = [];
let buf = '';
let i = 0;
const n = raw.length;
while (i < n) {
  const b = raw[i];
  if (b === 0x1b) {
    // CSI?
    if (i + 1 < n && raw[i + 1] === 0x5b) {
      let j = i + 2;
      while (j < n) {
        const c = raw[j];
        if (c >= 0x30 && c <= 0x3f) { j++; continue; }
        break;
      }
      while (j < n) {
        const c = raw[j];
        if (c >= 0x20 && c <= 0x2f) { j++; continue; }
        break;
      }
      if (j < n && raw[j] >= 0x40 && raw[j] <= 0x7e) { i = j + 1; continue; }
      i += 2; continue;
    }
    // OSC?
    if (i + 1 < n && raw[i + 1] === 0x5d) {
      let j = i + 2;
      while (j < n) {
        if (raw[j] === 0x07) { i = j + 1; break; }
        if (raw[j] === 0x1b && j + 1 < n && raw[j + 1] === 0x5c) { i = j + 2; break; }
        j++;
      }
      if (j >= n) { i = n; }
      continue;
    }
    // Other ESC sequences — skip 2 bytes
    i += 2; continue;
  }
  if (b === 0x0d) { buf = ''; i++; continue; }
  if (b === 0x0a) { lines.push(buf); buf = ''; i++; continue; }
  if (b < 0x20 && b !== 0x09) { i++; continue; }
  buf += String.fromCharCode(b);
  i++;
}
// Push trailing
if (buf) lines.push(buf);

// Decode each line as UTF-8 (we accumulated bytes as char codes which is wrong for multi-byte; let's redo properly)
// Actually re-decode each line: we kept byte values 0x00-0xff as ASCII chars. For multi-byte UTF-8, this produces garbled output. Fix:
const linesUtf8 = [];
let bbuf = Buffer.alloc(0);
let part = [];
for (let k = 0; k < n; k++) {
  const b = raw[k];
  if (b === 0x1b) {
    // Same escape handling as above
    if (k + 1 < n && raw[k + 1] === 0x5b) {
      let j = k + 2;
      while (j < n) { const c = raw[j]; if (c >= 0x30 && c <= 0x3f) { j++; continue; } break; }
      while (j < n) { const c = raw[j]; if (c >= 0x20 && c <= 0x2f) { j++; continue; } break; }
      if (j < n && raw[j] >= 0x40 && raw[j] <= 0x7e) { k = j; continue; }
      k += 1; continue;
    }
    if (k + 1 < n && raw[k + 1] === 0x5d) {
      let j = k + 2;
      while (j < n) {
        if (raw[j] === 0x07) { k = j; break; }
        if (raw[j] === 0x1b && j + 1 < n && raw[j + 1] === 0x5c) { k = j + 1; break; }
        j++;
      }
      if (j >= n) k = n - 1;
      continue;
    }
    k += 1; continue;
  }
  if (b === 0x0d) { part.length = 0; continue; }
  if (b === 0x0a) {
    linesUtf8.push(Buffer.from(part).toString('utf8'));
    part.length = 0;
    continue;
  }
  if (b < 0x20 && b !== 0x09) continue;
  part.push(b);
}
if (part.length) linesUtf8.push(Buffer.from(part).toString('utf8'));

const nonempty = linesUtf8.filter(l => l.trim());
console.log(`total lines committed: ${linesUtf8.length}`);
console.log(`non-empty:             ${nonempty.length}`);
console.log();
console.log('=== TOP 25 LONGEST non-empty lines ===');
nonempty.sort((a, b) => b.length - a.length);
for (const l of nonempty.slice(0, 25)) {
  console.log(`(${l.length}) ${JSON.stringify(l.slice(0, 250))}`);
}
console.log();
console.log('=== UNIQUE non-empty lines (frequency) ===');
const freq = new Map();
for (const l of nonempty) freq.set(l, (freq.get(l) || 0) + 1);
const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
console.log(`unique:                ${sorted.length}`);
for (const [l, c] of sorted.slice(0, 20)) {
  console.log(`  x${c}  ${JSON.stringify(l.slice(0, 200))}`);
}
