/**
 * Token refreshes in flight, by config dir. A CLI launched mid-refresh would
 * read the old pair and spend a refresh token the refresh just rotated, so
 * every launch waits here first.
 */

const pending = new Map<string, Promise<unknown>>();
/** Rotations refreshed but not yet saved, by config dir: one attempt to save each. */
const held = new Map<string, () => Promise<boolean>>();

export function trackTokenRefresh<T>(configDir: string, work: Promise<T>): Promise<T> {
  pending.set(configDir, work);
  const clear = () => {
    if (pending.get(configDir) === work) pending.delete(configDir);
  };
  work.then(clear, clear);
  return work;
}

/** A rotation the store refused; a launch on the dir tries the save once before the CLI reads the spent pair. */
export function holdRotation(configDir: string, save: () => Promise<boolean>): void {
  held.set(configDir, save);
}

export function releaseRotation(configDir: string): void {
  held.delete(configDir);
}

export function isTokenRefreshing(configDir: string | null | undefined): boolean {
  return configDir ? pending.has(configDir) || held.has(configDir) : false;
}

/** Resolves once no refresh is running for this config dir, and a held rotation has had one save. Never rejects. */
export async function tokenRefreshSettled(configDir: string | null | undefined): Promise<void> {
  if (!configDir) return;
  await pending.get(configDir)?.catch(() => undefined);
  const save = held.get(configDir);
  if (save) await trackTokenRefresh(configDir, save()).catch(() => undefined);
}
