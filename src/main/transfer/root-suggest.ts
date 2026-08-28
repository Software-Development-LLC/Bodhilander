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

import { sharedTrailingSegments, workingDirParts, type WorkingDirMapping } from './working-dirs';

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

/**
 * Every directory under `bases`, down to `maxDepth`, as path plus the
 * components that got there. Breadth-first so the shallowest matches — which
 * are the likeliest — are found before the budget runs out.
 */
function walk(options: SuggestOptions): Candidate[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxVisits = options.maxVisits ?? DEFAULT_MAX_VISITS;

  const found: Candidate[] = [];
  const seen = new Set<string>();
  let frontier: Candidate[] = [];

  for (const base of options.bases) {
    const parts = workingDirParts(base);
    if (!parts || seen.has(base)) continue;
    seen.add(base);
    const candidate = { path: base, segments: parts.segments };
    found.push(candidate);
    frontier.push(candidate);
  }

  let visits = 0;
  for (let depth = 0; depth < maxDepth && frontier.length > 0 && visits < maxVisits; depth++) {
    const next: Candidate[] = [];
    for (const parent of frontier) {
      if (visits >= maxVisits) break;
      for (const name of subdirsOf(options, parent.path)) {
        if (skipped(name)) continue;
        if (++visits > maxVisits) break;
        // Joined with the parent's own separator rather than the host's: a
        // base handed in as a Windows path stays one.
        const separator = parent.path.includes('\\') && !parent.path.includes('/') ? '\\' : '/';
        const path = parent.path.endsWith(separator) ? `${parent.path}${name}` : `${parent.path}${separator}${name}`;
        if (seen.has(path)) continue;
        seen.add(path);
        const child = { path, segments: [...parent.segments, name] };
        found.push(child);
        next.push(child);
      }
    }
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
export function suggestRootMappings(roots: string[], options: SuggestOptions): RootSuggestion[] {
  const wanted = roots
    .map((root) => ({ root, parts: workingDirParts(root) }))
    .filter((r): r is { root: string; parts: NonNullable<ReturnType<typeof workingDirParts>> } => r.parts !== null);
  if (wanted.length === 0) return [];

  const suggestions: RootSuggestion[] = [];
  const stillWanted: typeof wanted = [];

  // A root that is already here needs no search and no mapping. Checked first
  // so the common same-platform restore costs one stat per root and no walk.
  for (const entry of wanted) {
    if (options.directoryExists(entry.root)) {
      suggestions.push({
        from: entry.root,
        to: entry.root,
        matchedSegments: entry.parts.segments.length,
        unchanged: true,
      });
    } else {
      stillWanted.push(entry);
    }
  }
  if (stillWanted.length === 0) return suggestions;

  const candidates = walk(options);

  for (const { root, parts } of stillWanted) {
    if (parts.segments.length === 0) continue;

    let best = 0;
    let bestPaths: string[] = [];
    for (const candidate of candidates) {
      // Never propose moving a root to itself by another name, and never
      // propose a base that shares nothing with it.
      const shared = sharedTrailingSegments(parts, { segments: candidate.segments, windows: parts.windows });
      if (shared === 0) continue;
      if (shared > best) {
        best = shared;
        bestPaths = [candidate.path];
      } else if (shared === best) {
        bestPaths.push(candidate.path);
      }
    }

    // Exactly one directory matched better than every other. Anything else —
    // no match at all, or a tie — is a question for the user.
    if (best > 0 && bestPaths.length === 1) {
      suggestions.push({ from: root, to: bestPaths[0], matchedSegments: best, unchanged: false });
    }
  }

  return suggestions;
}

/** The subset of suggestions that actually move something. */
export function mappingsFrom(suggestions: RootSuggestion[]): WorkingDirMapping[] {
  return suggestions.filter((s) => !s.unchanged).map((s) => ({ from: s.from, to: s.to }));
}
