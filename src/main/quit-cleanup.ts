/**
 * The order of the async teardown `before-quit` runs inside its guarded
 * shutdown. Kept free of any `electron` import so it is unit-testable.
 */

/** The guarded shutdown force-exits after this; comfortably inside ShipIt's tolerance. */
export const QUIT_CLEANUP_BUDGET_MS = 2000;

/** One save of each held token pair, which is lost on exit; it must finish inside the cleanup budget. */
export const HELD_ROTATION_SAVE_MS = 1500;

export interface QuitCleanupSteps {
  saveHeldRotations: (budgetMs: number) => Promise<void>;
  killPtys: () => Promise<void>;
  stopServices: () => void;
  closeDatabase: () => void;
  logError: (message: string, err: unknown) => void;
}

export async function runQuitCleanup(steps: QuitCleanupSteps): Promise<void> {
  const savingHeldRotations = steps.saveHeldRotations(HELD_ROTATION_SAVE_MS);
  try {
    await steps.killPtys();
  } catch (e) {
    steps.logError('Error killing PTYs on quit:', e);
  }
  steps.stopServices();
  await savingHeldRotations;
  steps.closeDatabase();
}
