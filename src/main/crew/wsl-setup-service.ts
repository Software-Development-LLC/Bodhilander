/**
 * What the Windows setup screen asks for: where setup stands, Set up Crew on
 * Windows, and Repair. One of setup or Repair runs at a time; each ends by
 * re-running the start check, so held runs try again.
 */
import type { CrewWindowsProgress, CrewWindowsRepairResult, CrewWindowsSetupResult, CrewWindowsState } from '../../shared/types';
import { REPAIR_BUSY, SETUP_NEEDED_MESSAGE, type RepairOutcome, type WslCheck } from './wsl';
import { BUILD_NOT_READY, NEEDS_REPAIR, USER_CONFLICT, type SetupOutcome, type SetupStep, type StepResult } from './wsl-setup';

export const REPAIR_CANCELLED = 'Repair was cancelled. Nothing was changed.';

export function repairWaits(active: number): string {
  return `Repair waits until Crew's runs on this PC finish. ${active} ${active === 1 ? 'run is' : 'runs are'} still going.`;
}

export interface SetupServiceDeps {
  check(): Promise<WslCheck>;
  start(): Promise<void>;
  /** The last start or per-run check, or null before the first. */
  gateState(): StepResult | null;
  /** Crew runs open in BodhiCrew now; Repair never starts under one. */
  activeRuns(): number;
  /** True when this build's hashes or bundles are placeholders. */
  unbuilt(): boolean;
  setup(onStep: (step: SetupStep, message?: string) => void): Promise<SetupOutcome>;
  repairWsl1(confirm: (prompt: string) => Promise<boolean>): Promise<RepairOutcome>;
  repairUser(): Promise<StepResult>;
  repaired(): Promise<void>;
}

const fail = (message: string, repair: boolean): CrewWindowsSetupResult => ({ ok: false, message, repair });

export class WindowsSetupService {
  private running = false;

  constructor(private readonly deps: SetupServiceDeps) {}

  /** True while setup or Repair runs, so the run gate holds new runs. */
  get busy(): boolean {
    return this.running;
  }

  async state(): Promise<CrewWindowsState> {
    if (this.deps.unbuilt()) return { state: 'unbuilt', message: BUILD_NOT_READY };
    const wsl = await this.deps.check();
    if (wsl.state !== 'ok') return wsl;
    await this.deps.start();
    const gate = this.deps.gateState();
    return gate?.ok ? { state: 'ready' } : { state: 'needs-repair', message: gate?.message ?? NEEDS_REPAIR };
  }

  setup(onProgress: (p: CrewWindowsProgress) => void): Promise<CrewWindowsSetupResult> {
    return this.exclusive(() => this.finish(onProgress));
  }

  repair(confirmed: boolean): Promise<CrewWindowsRepairResult> {
    return this.exclusive(() => this.runRepair(confirmed));
  }

  private async exclusive<T>(fn: () => Promise<T | CrewWindowsSetupResult>): Promise<T | CrewWindowsSetupResult> {
    if (this.deps.unbuilt()) return fail(BUILD_NOT_READY, false);
    if (this.running) return fail(REPAIR_BUSY, false);
    this.running = true;
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }

  private async finish(onProgress: (p: CrewWindowsProgress) => void, note?: string): Promise<CrewWindowsSetupResult> {
    const out = await this.deps.setup((step, message) => onProgress(message === undefined ? { step } : { step, message }));
    if (!out.ok) return fail(out.message, out.repair === true);
    await this.deps.repaired();
    return note ? { ok: true, message: note } : { ok: true };
  }

  private async runRepair(confirmed: boolean): Promise<CrewWindowsRepairResult> {
    const active = this.deps.activeRuns();
    if (active > 0) return fail(repairWaits(active), true);
    const wsl = await this.deps.check();
    if (wsl.state === 'no-wsl') return fail(wsl.message, false);
    if (wsl.state === 'missing') return fail(SETUP_NEEDED_MESSAGE, false);
    if (wsl.state === 'wsl1') return this.repairWsl1(confirmed);
    const gate = this.deps.gateState();
    if (gate && !gate.ok && gate.message === USER_CONFLICT) {
      const user = await this.deps.repairUser();
      if (!user.ok) return fail(user.message, true);
    }
    return this.finish(() => {});
  }

  private async repairWsl1(confirmed: boolean): Promise<CrewWindowsRepairResult> {
    let asked: string | null = null;
    const out = await this.deps.repairWsl1(async (prompt) => {
      if (confirmed) return true;
      asked = prompt;
      return false;
    });
    switch (out.result) {
      case 'converted':
      case 'reimported':
      case 'restored':
        return this.finish(() => {});
      case 'fallback':
        return this.finish(() => {}, out.message);
      case 'cancelled':
        return asked ? { confirm: asked } : fail(REPAIR_CANCELLED, true);
      case 'busy':
        return fail(REPAIR_BUSY, false);
      default:
        return fail(out.message, true);
    }
  }
}
