/**
 * Where a machine keeps its checkouts, and how that is rewritten for another
 * machine. Paths arrive from EITHER platform, so nothing here may use `path`,
 * whose separator is fixed to the host at import time.
 */

export interface WorkingDirMapping {
  /** A root as it appeared in the manifest, i.e. on the source machine. */
  from: string;
  /** Where that tree lives on this machine. Empty means "leave it alone". */
  to: string;
}

const WINDOWS_DRIVE = /^[A-Za-z]:$/;
const UNC_PREFIX = /^[\\/]{2}[^\\/]/;

interface ParsedDir {
  /** Drive letter or `\\server\share`; '' for a posix path. */
  prefix: string;
  separator: string;
  absolute: boolean;
  /** Windows paths compare case-insensitively; posix ones do not. */
  windows: boolean;
  segments: string[];
}

function parseDir(dir: string): ParsedDir | null {
  const trimmed = dir.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]+/);

  if (UNC_PREFIX.test(trimmed)) {
    const separator = trimmed.includes('\\') ? '\\' : '/';
    parts.shift();
    const server = parts.shift() ?? '';
    const share = parts.shift() ?? '';
    // Server and share ARE the root of a UNC path — never remappable segments.
    const prefix = `${separator}${separator}${server}${share ? separator + share : ''}`;
    return { prefix, separator, absolute: true, windows: true, segments: parts.filter((p) => p !== '') };
  }

  if (WINDOWS_DRIVE.test(parts[0])) {
    const prefix = parts.shift()!;
    return { prefix, separator: '\\', absolute: true, windows: true, segments: parts.filter((p) => p !== '') };
  }

  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return {
    prefix: '',
    separator,
    absolute: parts[0] === '',
    windows: separator === '\\',
    segments: parts.filter((p) => p !== ''),
  };
}

function renderDir(parsed: ParsedDir, segments: string[]): string {
  const body = segments.join(parsed.separator);
  if (parsed.prefix) return `${parsed.prefix}${parsed.separator}${body}`;
  return parsed.absolute ? `${parsed.separator}${body}` : body;
}

/**
 * How one path component is compared. Windows matches case-insensitively and
 * POSIX does not, so the rule is chosen once per path and then applied — the
 * caller holds a folder rather than re-deciding at every component.
 */
type Fold = (segment: string) => string;

const foldExact: Fold = (segment) => segment;
const foldCaseless: Fold = (segment) => segment.toLowerCase();

function folderFor(windows: boolean): Fold {
  return windows ? foldCaseless : foldExact;
}

interface TrieNode {
  children: Map<string, { display: string; node: TrieNode }>;
  /** True when some working dir ends exactly here. */
  terminal: boolean;
}

function emptyNode(): TrieNode {
  return { children: new Map(), terminal: false };
}

/** Descend a single-child chain; stop where it branches or a directory ends. */
function descend(node: TrieNode, trail: string[]): string[] {
  if (node.terminal || node.children.size !== 1) return trail;
  const [child] = [...node.children.values()];
  return descend(child.node, [...trail, child.display]);
}

function rootsWithin(node: TrieNode, trail: string[]): string[][] {
  const settled = descend(node, trail);
  if (settled.length !== trail.length) return [settled];
  return [...node.children.values()].flatMap((child) =>
    rootsWithin(child.node, [...trail, child.display]),
  );
}

/**
 * The distinct roots a set of working directories fall under: the deepest
 * directory each family of paths still shares. Two checkouts side by side
 * produce the folder holding them, which is the unit a user actually remaps.
 */
export function collectWorkingDirRoots(dirs: string[]): string[] {
  const buckets = new Map<string, { sample: ParsedDir; trie: TrieNode; volumeRoot: boolean }>();

  for (const dir of dirs) {
    const parsed = parseDir(dir);
    if (!parsed) continue;

    const folder = folderFor(parsed.windows);
    const key = `${folder(parsed.prefix)}|${parsed.absolute}|${parsed.windows}`;
    const bucket = buckets.get(key) ?? { sample: parsed, trie: emptyNode(), volumeRoot: false };
    buckets.set(key, bucket);

    // A session sitting at a volume root has no segments to branch on, but the
    // user still has to be asked where that volume is on the new machine.
    if (parsed.segments.length === 0) {
      bucket.volumeRoot = true;
      continue;
    }

    let node = bucket.trie;
    for (const segment of parsed.segments) {
      const folded = folder(segment);
      const next = node.children.get(folded) ?? { display: segment, node: emptyNode() };
      node.children.set(folded, next);
      node = next.node;
    }
    node.terminal = true;
  }

  const roots: string[] = [];
  for (const { sample, trie, volumeRoot } of buckets.values()) {
    if (volumeRoot) roots.push(renderDir(sample, []));
    for (const segments of rootsWithin(trie, [])) {
      roots.push(renderDir(sample, segments));
    }
  }
  // A fixed locale, not the host's: an export written on one machine is read
  // on another, and the roots the user is asked about should come back in the
  // same order on both.
  return [...new Set(roots)].sort((a, b) => a.localeCompare(b, 'en'));
}

/** Whether `subject` sits at or under `from`, compared component by component. */
function startsWithDir(subject: ParsedDir, from: ParsedDir, folder: Fold): boolean {
  if (folder(subject.prefix) !== folder(from.prefix)) return false;
  if (subject.absolute !== from.absolute) return false;
  if (subject.segments.length < from.segments.length) return false;
  return from.segments.every((s, i) => folder(s) === folder(subject.segments[i]));
}

/**
 * Rewrite one directory through the user's root mappings. An unmapped
 * directory comes back untouched — on a restore to the same machine that is
 * the correct answer, and elsewhere it is what marks the session for relink.
 */
export function remapWorkingDir(dir: string, mappings: WorkingDirMapping[]): string {
  const subject = parseDir(dir);
  if (!subject) return dir;

  const candidates = mappings
    .filter((m) => m.from.trim() !== '' && m.to.trim() !== '')
    .map((m) => ({ mapping: m, from: parseDir(m.from) }))
    .filter((c): c is { mapping: WorkingDirMapping; from: ParsedDir } => c.from !== null)
    .sort((a, b) => b.from.segments.length - a.from.segments.length);

  for (const { mapping, from } of candidates) {
    const folder = folderFor(from.windows || subject.windows);
    if (!startsWithDir(subject, from, folder)) continue;

    const tail = subject.segments.slice(from.segments.length);
    if (tail.length === 0) return mapping.to;

    const target = parseDir(mapping.to);
    if (!target) continue;
    return renderDir(target, [...target.segments, ...tail]);
  }
  return dir;
}
