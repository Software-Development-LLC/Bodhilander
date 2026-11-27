import { describe, expect, test } from 'bun:test';
import type { CrewWindowsProgress } from '../../../shared/types';
import { NO_WSL_MESSAGE, REPAIR_BUSY, REPAIR_PROMPT, SETUP_NEEDED_MESSAGE, WSL1_MESSAGE, type RepairOutcome, type WslCheck } from '../wsl';
import { BUILD_NOT_READY, NEEDS_REPAIR, USER_CONFLICT, type SetupOutcome, type StepResult } from '../wsl-setup';
import { repairWaits, WindowsSetupService, type SetupServiceDeps } from '../wsl-setup-service';

const held = (message: string): StepResult => ({ ok: false, hold: 'held:setup', message, audit: {} });

function service(over: Partial<SetupServiceDeps> & { wsl?: WslCheck } = {}) {
  const calls: string[] = [];
  const deps: SetupServiceDeps = {
    check: async () => over.wsl ?? { state: 'ok' },
    start: async () => void calls.push('start'),
    gateState: () => ({ ok: true }),
    activeRuns: () => 0,
    unbuilt: () => false,
    setup: async (onStep) => (onStep('user'), calls.push('setup'), { ok: true }),
    repairWsl1: async () => (calls.push('repairWsl1'), { result: 'converted' }),
    repairUser: async () => (calls.push('repairUser'), { ok: true }),
    repaired: async () => void calls.push('repaired'),
    ...over,
  };
  return { svc: new WindowsSetupService(deps), calls };
}

describe('the Windows setup screen state', () => {
  test('no WSL, a missing BodhiCrew and WSL1 are said as the check says them, without starting the gate', async () => {
    for (const wsl of [{ state: 'no-wsl', message: NO_WSL_MESSAGE }, { state: 'missing', message: SETUP_NEEDED_MESSAGE }, { state: 'wsl1', message: WSL1_MESSAGE }] as const) {
      const t = service({ wsl });
      expect(await t.svc.state()).toEqual(wsl);
      expect(t.calls).toEqual([]);
    }
  });

  test('a BodhiCrew on WSL2 is ready only once the start check passes', async () => {
    const t = service();
    expect(await t.svc.state()).toEqual({ state: 'ready' });
    expect(t.calls).toEqual(['start']);
    const u = service({ gateState: () => held(USER_CONFLICT) });
    expect(await u.svc.state()).toEqual({ state: 'needs-repair', message: USER_CONFLICT });
    const v = service({ gateState: () => null });
    expect(await v.svc.state()).toEqual({ state: 'needs-repair', message: NEEDS_REPAIR });
  });
});

describe('a build carrying placeholder hashes or no bundles', () => {
  test('says so, and neither setup nor Repair touches the PC', async () => {
    let checked = false;
    const t = service({ unbuilt: () => true, check: async () => ((checked = true), { state: 'wsl1', message: WSL1_MESSAGE }) });
    expect(BUILD_NOT_READY).toBe("This build of Bodhilander can't set up Crew on Windows yet.");
    expect(await t.svc.state()).toEqual({ state: 'unbuilt', message: BUILD_NOT_READY });
    expect(await t.svc.setup(() => {})).toEqual({ ok: false, message: BUILD_NOT_READY, repair: false });
    expect(await t.svc.repair(true)).toEqual({ ok: false, message: BUILD_NOT_READY, repair: false });
    expect(checked).toBe(false);
    expect(t.calls).toEqual([]);
  });
});

describe('Set up Crew on Windows', () => {
  test('reports each step, and a finished setup lets held runs try again', async () => {
    const t = service();
    const steps: CrewWindowsProgress[] = [];
    expect(await t.svc.setup((p) => steps.push(p))).toEqual({ ok: true });
    expect(steps).toEqual([{ step: 'user' }]);
    expect(t.calls).toEqual(['setup', 'repaired']);
  });

  test('a failed step says why and whether Repair can fix it, and releases nothing', async () => {
    const t = service({ setup: async () => ({ ok: false, step: 'apt', message: NEEDS_REPAIR, repair: true }) as SetupOutcome });
    expect(await t.svc.setup(() => {})).toEqual({ ok: false, message: NEEDS_REPAIR, repair: true });
    expect(t.calls).not.toContain('repaired');
  });

  test('a second setup or Repair while one runs is refused', async () => {
    let finish: (o: SetupOutcome) => void = () => {};
    const t = service({ setup: () => new Promise((r) => (finish = r)) });
    const first = t.svc.setup(() => {});
    expect(await t.svc.setup(() => {})).toEqual({ ok: false, message: REPAIR_BUSY, repair: false });
    expect(await t.svc.repair(false)).toEqual({ ok: false, message: REPAIR_BUSY, repair: false });
    finish({ ok: true });
    expect(await first).toEqual({ ok: true });
  });
});

describe('Repair', () => {
  test("on WSL1 with hire data it asks first, and only Continue goes on", async () => {
    let confirmed: boolean | null = null;
    const repairWsl1 = async (confirm: (p: string) => Promise<boolean>): Promise<RepairOutcome> => {
      confirmed = await confirm(REPAIR_PROMPT);
      return confirmed ? { result: 'restored' } : { result: 'cancelled' };
    };
    const t = service({ wsl: { state: 'wsl1', message: WSL1_MESSAGE }, repairWsl1 });
    expect(await t.svc.repair(false)).toEqual({ confirm: REPAIR_PROMPT });
    expect(t.calls).toEqual([]);
    expect(await t.svc.repair(true)).toEqual({ ok: true });
    expect(confirmed).toBe(true);
    expect(t.calls).toEqual(['setup', 'repaired']);
  });

  test("a fallback finishes setup and passes on the restore message", async () => {
    const t = service({ wsl: { state: 'wsl1', message: WSL1_MESSAGE }, repairWsl1: async () => ({ result: 'fallback', backup: 'b.tar', message: 'restore hire folders' }) });
    expect(await t.svc.repair(true)).toEqual({ ok: true, message: 'restore hire folders' });
  });

  test('a Repair that changes nothing says why and does not finish setup', async () => {
    const t = service({ wsl: { state: 'wsl1', message: WSL1_MESSAGE }, repairWsl1: async () => ({ result: 'short-space', needBytes: 1, message: 'needs space' }) });
    expect(await t.svc.repair(true)).toEqual({ ok: false, message: 'needs space', repair: true });
    expect(t.calls).toEqual([]);
  });

  test("a user conflict is repaired before setup's steps run again", async () => {
    const t = service({ gateState: () => held(USER_CONFLICT) });
    expect(await t.svc.repair(false)).toEqual({ ok: true });
    expect(t.calls).toEqual(['repairUser', 'setup', 'repaired']);
  });

  test('Repair waits while Crew runs on this PC, saying how many, and changes nothing', async () => {
    let checked = false;
    const t = service({ activeRuns: () => 2, check: async () => ((checked = true), { state: 'wsl1', message: WSL1_MESSAGE }) });
    for (const confirmed of [false, true]) expect(await t.svc.repair(confirmed)).toEqual({ ok: false, message: repairWaits(2), repair: true });
    expect(repairWaits(2)).toContain("Repair waits until Crew's runs on this PC finish");
    expect(repairWaits(2)).toContain('2');
    expect(checked).toBe(false);
    expect(t.calls).toEqual([]);
  });

  test('while setup or Repair runs, the service says it is busy so runs are held', async () => {
    let finish: (o: SetupOutcome) => void = () => {};
    const t = service({ setup: () => new Promise((r) => (finish = r)) });
    expect(t.svc.busy).toBe(false);
    const first = t.svc.repair(false);
    expect(t.svc.busy).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    finish({ ok: true });
    await first;
    expect(t.svc.busy).toBe(false);
  });

  test('no WSL or no BodhiCrew is not something Repair fixes', async () => {
    expect(await service({ wsl: { state: 'no-wsl', message: NO_WSL_MESSAGE } }).svc.repair(true)).toEqual({ ok: false, message: NO_WSL_MESSAGE, repair: false });
    expect(await service({ wsl: { state: 'missing', message: SETUP_NEEDED_MESSAGE } }).svc.repair(true)).toEqual({ ok: false, message: SETUP_NEEDED_MESSAGE, repair: false });
  });
});
