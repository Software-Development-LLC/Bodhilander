/**
 * The config dirs each run's gates have launched under. A `--bg` gate outlives
 * its launch, and the run's resolved account can move while it runs, so the
 * dirs a run actually used are kept until the run is no longer active.
 */
const launchedDirs = new Map<string, Set<string>>();

export function recordGateConfigDir(runId: string, configDir: string | null): void {
  if (!configDir) return;
  const dirs = launchedDirs.get(runId) ?? new Set<string>();
  dirs.add(configDir);
  launchedDirs.set(runId, dirs);
}

/** Every dir launched by a still-active run; inactive runs are forgotten. */
export function activeGateConfigDirs(activeRunIds: Iterable<string>): string[] {
  const active = new Set(activeRunIds);
  for (const runId of [...launchedDirs.keys()]) {
    if (!active.has(runId)) launchedDirs.delete(runId);
  }
  return [...launchedDirs.values()].flatMap(dirs => [...dirs]);
}

export function clearGateConfigDirs(): void {
  launchedDirs.clear();
}
