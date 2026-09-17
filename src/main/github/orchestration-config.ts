/**
 * The central orchestration config, fetched at runtime (board-driven
 * orchestration, Phase 2).
 *
 * GitHub Projects v2 holds the work *structure*; this holds the domain *policy*
 * GitHub doesn't — which agent owns a repo, its integration branch / provision
 * command / key-prefix, per-owner and per-project context. It lives in a config
 * repo the app fetches via `gh` and caches, so adding or updating a project
 * needs no app release ("mix of both" — a person or the project-generation
 * automation edits the JSON).
 *
 * `parseConfig` is pure (testable dry); `loadConfig` takes its `gh`, cache and
 * clock as deps (same shape as `board-service`), and `loadOrchestrationConfig`
 * wires the real ones. A malformed file is a LOUD problem; a transient fetch
 * failure falls back to the last good cache marked stale.
 */
import type { CommandResult } from '../run-engine/reconcile';
import { processDeps } from '../run-engine/command-runner';
import * as machine from '../run-engine/machine-config';
import { getPreference, setPreference } from '../repositories/preferences';
import type { ConfigResult, OrchestrationConfig, RepoConfig } from '../../shared/types';

/** The only config version this app understands. */
const SUPPORTED_VERSION = 1;
/** How long a cached config is served before a refetch. */
const TTL_MS = 5 * 60_000;
/** Where the parsed config + its fetch time are cached (JSON in one preference). */
const CACHE_KEY = 'runEngine.configCache';

type ParseResult = { status: 'ok'; config: OrchestrationConfig } | { status: 'problem'; problem: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}
/** A list of non-empty strings, or undefined when absent/not an array of strings. */
function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim());
  return list.length > 0 ? list : undefined;
}

/** Pick the known string fields of a repo entry; unknown keys are ignored (forward-compat). */
function toRepoConfig(v: unknown): RepoConfig {
  const r = asRecord(v) ?? {};
  return {
    keyPrefix: str(r.keyPrefix),
    integrationBranch: str(r.integrationBranch),
    provision: str(r.provision),
    ownerAgent: str(r.ownerAgent),
    context: str(r.context),
  };
}

/**
 * Validate + normalize the config JSON. Never throws; a wrong version or a
 * non-object `repos` is a surfaced problem, not a mid-run surprise.
 */
export function parseConfig(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'problem', problem: 'config is not valid JSON' };
  }
  const root = asRecord(parsed);
  if (!root) return { status: 'problem', problem: 'config must be a JSON object' };
  if (root.version !== SUPPORTED_VERSION) {
    return { status: 'problem', problem: `unsupported config version ${JSON.stringify(root.version)} (expected ${SUPPORTED_VERSION})` };
  }
  const reposRaw = asRecord(root.repos);
  if (!reposRaw) return { status: 'problem', problem: 'config.repos must be an object of repo → settings' };

  const repos: Record<string, RepoConfig> = {};
  for (const [name, entry] of Object.entries(reposRaw)) repos[name] = toRepoConfig(entry);

  const owners: Record<string, { context?: string }> = {};
  for (const [name, entry] of Object.entries(asRecord(root.owners) ?? {})) {
    owners[name] = { context: str(asRecord(entry)?.context) };
  }
  const projects: Record<string, { context?: string; eligibleStatuses?: string[] }> = {};
  for (const [num, entry] of Object.entries(asRecord(root.projects) ?? {})) {
    const e = asRecord(entry);
    projects[num] = { context: str(e?.context), eligibleStatuses: strList(e?.eligibleStatuses) };
  }
  return { status: 'ok', config: { version: SUPPORTED_VERSION, repos, owners, projects } };
}

interface CachedConfig {
  config: OrchestrationConfig;
  fetchedAt: string;
}

export interface ConfigDeps {
  gh(argv: readonly string[]): Promise<CommandResult>;
  /** `owner/repo` of the config repo, or null when unset. */
  repoSlug: string | null;
  /** Path to the config JSON within the repo. */
  path: string;
  readCache(): CachedConfig | null;
  writeCache(value: CachedConfig): void;
  now(): number;
  ttlMs: number;
}

/** `gh api repos/<slug>/contents/<path>` with the raw-content accept header. */
export function configFetchArgv(repoSlug: string, path: string): string[] {
  return ['api', `repos/${repoSlug}/contents/${path}`, '-H', 'Accept: application/vnd.github.raw'];
}

/**
 * Load the config: serve a fresh cache within the TTL, else refetch. A transient
 * fetch failure serves the last good cache marked stale; a malformed file is a
 * loud problem (never hidden behind a stale cache).
 */
export async function loadConfig(deps: ConfigDeps, opts: { force?: boolean } = {}): Promise<ConfigResult> {
  if (!deps.repoSlug) {
    return { status: 'problem', problem: 'No config repo configured — set it in Settings → Run engine.' };
  }
  const cached = deps.readCache();
  if (!opts.force && cached) {
    const age = deps.now() - Date.parse(cached.fetchedAt);
    if (Number.isFinite(age) && age >= 0 && age < deps.ttlMs) {
      return { status: 'ok', config: cached.config, fetchedAt: cached.fetchedAt };
    }
  }

  const out = await deps.gh(configFetchArgv(deps.repoSlug, deps.path));
  if (out.code !== 0) {
    // Transient fetch failure: keep serving the last good config rather than
    // blanking it, but say it's stale.
    if (cached) return { status: 'ok', config: cached.config, fetchedAt: cached.fetchedAt, stale: true };
    const stderr = out.stderr.trim();
    const detail = stderr.length > 0 ? stderr : `exit ${out.code}`;
    return { status: 'problem', problem: `could not fetch config from ${deps.repoSlug}/${deps.path}: ${detail}` };
  }

  const parsed = parseConfig(out.stdout);
  if (parsed.status === 'problem') {
    // The file itself is wrong — surface it loudly, don't serve stale over a bug.
    return { status: 'problem', problem: `config at ${deps.repoSlug}/${deps.path} is invalid: ${parsed.problem}` };
  }
  const fetchedAt = new Date(deps.now()).toISOString();
  deps.writeCache({ config: parsed.config, fetchedAt });
  return { status: 'ok', config: parsed.config, fetchedAt };
}

/** Read the cached config from its preference, or null when absent/unreadable. */
function readCache(): CachedConfig | null {
  try {
    const raw = getPreference(CACHE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as CachedConfig;
    return value?.config ? value : null;
  } catch {
    return null;
  }
}

/** Load the config with the real gh + preference cache + settings. */
export function loadOrchestrationConfig(opts: { force?: boolean } = {}): Promise<ConfigResult> {
  return loadConfig(
    {
      gh: (argv) => processDeps({ ghPath: machine.ghPath(), pythonPath: 'python' }).gh(argv),
      repoSlug: machine.configRepo(),
      path: machine.configPath(),
      readCache,
      writeCache: (value) => setPreference(CACHE_KEY, JSON.stringify(value)),
      now: () => Date.now(),
      ttlMs: TTL_MS,
    },
    opts,
  );
}
