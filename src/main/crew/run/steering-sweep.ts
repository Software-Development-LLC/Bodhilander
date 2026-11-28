/**
 * Claude reads CLAUDE.md, CLAUDE.local.md and .claude/ from any directory it
 * works in, so before a run every one of them under the run root is removed
 * and only the generated handbook and skills are written back.
 */
import * as fs from 'fs';
import * as path from 'path';

const STEERING = new Set(['claude.md', 'claude.local.md', '.claude']);

export function sweepSteering(root: string): void {
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (STEERING.has(e.name.toLowerCase())) fs.rmSync(p, { recursive: true, force: true });
      else if (e.isDirectory()) walk(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
}

const QUOTE_ESCAPE = "'\\''";
const q = (s: string): string => `'${s.replace(/'/g, QUOTE_ESCAPE)}'`;

export function wslSweepSteering(root: string): string {
  return `find ${q(root)} -mindepth 1 \\( -iname CLAUDE.md -o -iname CLAUDE.local.md -o -iname .claude \\) -prune -exec rm -rf {} +`;
}
