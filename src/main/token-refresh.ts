/**
 * Token refreshes in flight, by config dir. A CLI launched mid-refresh would
 * read the old pair and spend a refresh token the refresh just rotated, so
 * every launch waits here first.
 */

const pending = new Map<string, Promise<unknown>>();
/** Rotations refreshed but not yet saved, by config dir: one attempt to save each. */
const held = new Map<string, () => Promise<boolean>>();

/** How long a launch waits on a held save before it goes ahead. */
export const LAUNCH_SAVE_BUDGET_MS = 3_000;

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

/** One save of a held rotation, shared with any save already running for the dir. */
function saveHeld(configDir: string): Promise<unknown> {
  const save = held.get(configDir);
  if (!save) return Promise.resolve();
  return (pending.get(configDir) ?? trackTokenRefresh(configDir, save())).catch(() => undefined);
}

async function within(work: Promise<unknown>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, budgetMs);
    timer.unref?.();
  });
  await Promise.race([work, timeout]);
  clearTimeout(timer);
}

/**
 * Resolves once no refresh is running for this config dir, and a held rotation
 * has had one save, for at most `saveBudgetMs`. Never rejects.
 */
export async function tokenRefreshSettled(
  configDir: string | null | undefined,
  saveBudgetMs: number = LAUNCH_SAVE_BUDGET_MS,
): Promise<void> {
  if (!configDir) return;
  if (!held.has(configDir)) await pending.get(configDir)?.catch(() => undefined);
  if (held.has(configDir)) await within(saveHeld(configDir), saveBudgetMs);
}

/** One save of every held rotation, all within `budgetMs`, for the way out. Never rejects. */
export function saveHeldRotations(budgetMs: number): Promise<void> {
  return within(Promise.all([...held.keys()].map(saveHeld)), budgetMs);
}
