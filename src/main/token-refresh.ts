/**
 * Token refreshes in flight, by config dir. A CLI launched mid-refresh would
 * read the old pair and spend a refresh token the refresh just rotated, so
 * every launch waits here first.
 */

const pending = new Map<string, Promise<unknown>>();

export function trackTokenRefresh<T>(configDir: string, work: Promise<T>): Promise<T> {
  pending.set(configDir, work);
  const clear = () => {
    if (pending.get(configDir) === work) pending.delete(configDir);
  };
  work.then(clear, clear);
  return work;
}

/** Resolves once no refresh is running for this config dir. Never rejects. */
export async function tokenRefreshSettled(configDir: string | null | undefined): Promise<void> {
  const work = configDir ? pending.get(configDir) : undefined;
  if (work) await work.catch(() => undefined);
}
