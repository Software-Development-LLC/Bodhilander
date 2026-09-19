/**
 * Seam-manifest anomaly checks for auto-approval (CO-722, B2).
 *
 * A cross-repo run parks at `awaitingManifest` for a person to approve the seam
 * manifest before owners touch code. That human click is the last forced step
 * before an otherwise hands-off run, so the engine auto-approves a manifest that
 * looks sound and only HALTS for a person when something looks off -- the cheap
 * place to be wrong.
 *
 * This is the "looks off" test. It is deliberately NARROW: `arch` already ran
 * the harness's own `verify_seams.py`, which is the deep structural/contract
 * check, and a manifest only reaches here having passed it. What this adds is
 * the handful of POLICY checks a structural verifier does not make -- the ones
 * that would waste a whole run or need a person's judgement:
 *
 *   - an empty manifest (arch produced no seams),
 *   - a repo the run would BUILD or MERGE that is outside its scope (it has no
 *     worktree -- spawn only cuts them for scoped repos -- so the run cannot
 *     actually produce it),
 *   - two seams sharing an id (an authoring slip the verifier may not catch),
 *   - a runaway seam count (a plausible sign arch's scope ran away).
 *
 * Note on what is NOT checked: overlapping file scopes between owners cannot
 * happen in this model -- team.yaml maps exactly one owner per repo, so two
 * owners are always different repos and never claim the same path. A CONSUMER
 * repo named by a seam is allowed to be out of scope: a consumer is a read-only
 * reference, not something this run builds, so only producers, the merge order
 * and post-merge scripts are held to the scope.
 *
 * Pure and dependency-light (only the `yaml` parser): the anomaly verdict is a
 * value, so the driver and its tests decide what to do with it.
 */
import { parse } from 'yaml';

/** A clean manifest, or the one-line reason a person is needed. */
export type ManifestAnomaly = { ok: true } | { ok: false; reason: string };

/**
 * Above this many seams, hold for a person. Real manifests seen in the harness
 * run from a few seams to a few dozen; this is a runaway ceiling, not a target,
 * so it sits well above the largest real one rather than trying to be tight.
 */
export const MAX_SEAMS = 60;

/**
 * Decide whether a seam manifest can be auto-approved.
 *
 * `scopeRepos` is the run's own scope (the tester's repo picks), the authority
 * for what this run may build. A manifest that would build or merge anything
 * outside it is held, because spawn cut no worktree for it.
 */
export function checkManifestAnomalies(seamsYaml: string, scopeRepos: readonly string[]): ManifestAnomaly {
  let doc: unknown;
  try {
    doc = parse(seamsYaml);
  } catch (err) {
    return { ok: false, reason: `the seam manifest is not valid YAML: ${firstLine(err)}` };
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, reason: 'the seam manifest is empty or malformed' };
  }

  const manifest = doc as Record<string, unknown>;
  const seams = asObjectArray(manifest.seams);
  if (seams.length === 0) {
    return { ok: false, reason: 'the seam manifest declares no seams' };
  }
  if (seams.length > MAX_SEAMS) {
    return {
      ok: false,
      reason: `the seam manifest declares ${seams.length} seams (over the ${MAX_SEAMS} ceiling) -- likely runaway scope`,
    };
  }

  const duplicateId = firstDuplicate(seams.map((seam) => (typeof seam.id === 'string' ? seam.id : null)));
  if (duplicateId) {
    return { ok: false, reason: `two seams share the id "${duplicateId}"` };
  }

  const scope = new Set(scopeRepos);
  const offenders = new Set<string>();
  // Repos that MERGE must be scoped: a merge_order entry with no worktree cannot
  // be built or landed.
  for (const repo of asStringArray(manifest.merge_order)) {
    if (!scope.has(repo)) offenders.add(repo);
  }
  // Repos that PRODUCE a seam must be scoped, for the same reason. Consumers are
  // deliberately not held -- they are references, not builds.
  for (const seam of seams) {
    const repo = producerRepo(seam);
    if (repo && !scope.has(repo)) offenders.add(repo);
  }
  // Post-merge scripts run in an owned repo's tree, so their repo must be scoped.
  for (const step of asObjectArray(manifest.post_merge)) {
    if (typeof step.repo === 'string' && !scope.has(step.repo)) offenders.add(step.repo);
  }
  if (offenders.size > 0) {
    const list = [...offenders].sort().join(', ');
    return {
      ok: false,
      reason: `the manifest would build or merge repos outside this run's scope: ${list}`,
    };
  }

  return { ok: true };
}

/** A seam's producer repo, or null when the seam does not name one. */
function producerRepo(seam: Record<string, unknown>): string | null {
  const producer = seam.producer;
  if (producer && typeof producer === 'object') {
    const repo = (producer as Record<string, unknown>).repo;
    if (typeof repo === 'string') return repo;
  }
  return null;
}

/** The array's entries that are objects; [] for anything else. */
function asObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
}

/** The array's entries that are strings; [] for anything else. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** The first value that appears twice, or null. Nulls (absent ids) are ignored. */
function firstDuplicate(values: (string | null)[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (value === null) continue;
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

/** The first non-empty line of an error's message, for a one-line reason. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? 'parse error';
}
