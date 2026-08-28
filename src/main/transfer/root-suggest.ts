/**
 * Guessing where a source machine's checkout roots live on this one.
 *
 * Most remapping after a restore is one prefix swap — `/Users/will/Work` on a
 * Mac becomes `C:\Users\will\Work`, and every session under it follows. The
 * manifest already records the roots; this looks for each of them here and
 * proposes an answer, so the user confirms a mapping rather than filling in a
 * form of them.
 *
 * A proposal is never applied on its own. Everything here is advice: the
 * caller shows it, the user takes it or overrides it, and a root with no
 * confident match simply falls through to being asked, exactly as before.
 */

import {
  sharedTrailingSegments,
  workingDirParts,
  type WorkingDirMapping,
  type WorkingDirParts,
} from './working-dirs';

export interface RootSuggestion {
  /** The root as the manifest recorded it, on the source machine. */
  from: string;
  /** Where it appears to live here. */
  to: string;
  /**
   * How many trailing components of `from` the match shares. 1 is a bare
   * leaf-name match; higher means more of the tail lined up, which is the
   * difference between "some folder called `Repos`" and "the same `Work/Repos`".
   */
  matchedSegments: number;
  /** True when the root is already at this exact path, so nothing need move. */
  unchanged: boolean;
}

export interface SuggestOptions {
  /** Where to look. The caller supplies this machine's obvious starting points. */
  bases: string[];
  /**
   * Immediate subdirectory names of `dir`. Injected so the search is exercised
   * without a filesystem. It may throw — a home directory routinely contains
   * something the user cannot read — and that is treated as empty.
   */
  readSubdirs: (dir: string) => string[];
  /** Whether a path is a directory on this machine. */
  directoryExists: (dir: string) => boolean;
  /** How far below each base to descend. */
  maxDepth?: number;
  /**
   * Ceiling on directories visited across the whole search. A home directory
   * can be enormous, and this runs while somebody waits on a restore.
   */
  maxVisits?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_VISITS = 4000;

/**
 * Never descended into. Not a security boundary — a scan that wandered into
 * one of these would be slow and would surface matches nobody means, e.g. the
 * `bin` inside a virtualenv standing in for a real one.
 */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.svn', '.hg', 'vendor', 'target', 'dist', 'build',
  '.venv', 'venv', '__pycache__', '.cache', '.Trash', 'Library', 'AppData',
  '.gradle', '.m2', '.cargo', '.rustup', '.npm', '.bun', '.nvm',
]);

function skipped(name: string): boolean {
  // Dotfiles are skipped wholesale beyond the named ones: a checkout root is
  // not usually hidden, and `~/.config` alone holds thousands of directories.
  return name.startsWith('.') || SKIPPED_DIRS.has(name);
}

/** A directory that cannot be listed contributes nothing and stops nothing. */
function subdirsOf(options: SuggestOptions, dir: string): string[] {
  try {
    return options.readSubdirs(dir);
  } catch {
    return [];
  }
}

interface Candidate {
  path: string;
  segments: string[];
}

/** Join with the parent's own separator, so a Windows base stays one. */
function joinPath(parent: string, name: string): string {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

/** The bases themselves, which are candidates before anything is descended. */
function seedFrontier(bases: string[], seen: Set<string>): Candidate[] {
  const seeds: Candidate[] = [];
  for (const base of bases) {
    const parts = workingDirParts(base);
    if (!parts || seen.has(base)) continue;
    seen.add(base);
    seeds.push({ path: base, segments: parts.segments });
  }
  return seeds;
}

/** How many more directories this walk may look at. */
interface Budget {
  left: number;
}

/** One directory's unseen subdirectories, as far as the budget allows. */
function childrenOf(
  parent: Candidate,
  options: SuggestOptions,
  seen: Set<string>,
  budget: Budget,
): Candidate[] {
  const children: Candidate[] = [];
  for (const name of subdirsOf(options, parent.path)) {
    if (budget.left <= 0) break;
    if (skipped(name)) continue;
    budget.left--;
    const path = joinPath(parent.path, name);
    if (seen.has(path)) continue;
    seen.add(path);
    children.push({ path, segments: [...parent.segments, name] });
  }
  return children;
}

/**
 * Every directory under `bases`, down to `maxDepth`, as path plus the
 * components that got there. Breadth-first so the shallowest matches — which
 * are the likeliest — are found before the budget runs out.
 */
function walk(options: SuggestOptions): Candidate[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const budget: Budget = { left: options.maxVisits ?? DEFAULT_MAX_VISITS };
  const seen = new Set<string>();

  let frontier = seedFrontier(options.bases, seen);
  const found = [...frontier];

  for (let depth = 0; depth < maxDepth && frontier.length > 0 && budget.left > 0; depth++) {
    const next = frontier.flatMap((parent) => childrenOf(parent, options, seen, budget));
    found.push(...next);
    frontier = next;
  }
  return found;
}

/**
 * The best guess for each root, or nothing for a root whose answer is not
 * clear. Ambiguity is deliberately left unanswered: two equally good matches
 * mean the machine does not know, and saying so is better than picking one and
 * quietly moving somebody's sessions to the wrong tree.
 */
interface WantedRoot {
  root: string;
  parts: WorkingDirParts;
}

/**
 * The single best-matching directory, or null when there is no match or more
 * than one equally good one. A tie is not a near-miss to break in favour of
 * the first: it is the machine saying it does not know.
 */
function bestMatchFor(wanted: WantedRoot, candidates: Candidate[]): RootSuggestion | null {
  if (wanted.parts.segments.length === 0) return null;

  let best = 0;
  let bestPaths: string[] = [];
  for (const candidate of candidates) {
    const shared = sharedTrailingSegments(wanted.parts, {
      segments: candidate.segments,
      windows: wanted.parts.windows,
    });
    if (shared === 0 || shared < best) continue;
    if (shared > best) {
      best = shared;
      bestPaths = [candidate.path];
    } else {
      bestPaths.push(candidate.path);
    }
  }

  if (best === 0 || bestPaths.length !== 1) return null;
  return { from: wanted.root, to: bestPaths[0], matchedSegments: best, unchanged: false };
}

/**
 * A root already at this path needs no search and no mapping. Split out first
 * so the common same-platform restore costs one stat per root and no walk.
 */
function splitByPresence(
  roots: string[],
  directoryExists: (dir: string) => boolean,
): { here: RootSuggestion[]; elsewhere: WantedRoot[] } {
  const here: RootSuggestion[] = [];
  const elsewhere: WantedRoot[] = [];

  for (const root of roots) {
    const parts = workingDirParts(root);
    if (!parts) continue;
    if (directoryExists(root)) {
      here.push({ from: root, to: root, matchedSegments: parts.segments.length, unchanged: true });
    } else {
      elsewhere.push({ root, parts });
    }
  }
  return { here, elsewhere };
}

export function suggestRootMappings(roots: string[], options: SuggestOptions): RootSuggestion[] {
  const { here, elsewhere } = splitByPresence(roots, options.directoryExists);
  if (elsewhere.length === 0) return here;

  const candidates = walk(options);
  const matched = elsewhere
    .map((wanted) => bestMatchFor(wanted, candidates))
    .filter((s): s is RootSuggestion => s !== null);

  return [...here, ...matched];
}

/** The subset of suggestions that actually move something. */
export function mappingsFrom(suggestions: RootSuggestion[]): WorkingDirMapping[] {
  return suggestions.filter((s) => !s.unchanged).map((s) => ({ from: s.from, to: s.to }));
}
