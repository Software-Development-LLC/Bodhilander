import { describe, expect, test, mock } from 'bun:test';

/**
 * The resolution order is the whole contract: preference beats env beats
 * default. A mutable fake preferences store lets one test walk a value down
 * all three rungs deterministically, with no real database in the room.
 */
const store: Record<string, string | null> = {};
mock.module('../../repositories/preferences', () => ({
  getPreference: (key: string) => store[key] ?? null,
}));

// Imported after the mock is registered so its `getPreference` binding is the fake.
const machine = await import('../machine-config');

function clearEnv() {
  for (const k of ['BODHI_CLAUDE', 'BODHI_GH', 'BODHI_PYTHON', 'BODHI_APPROVERS', 'BODHI_ROOT']) {
    delete process.env[k];
  }
  for (const k of Object.keys(store)) delete store[k];
}

describe('machine config resolution', () => {
  test('a preference beats the env var beats the built-in default', () => {
    clearEnv();
    // default
    expect(machine.claudePath()).toBe('claude');
    // env over default
    process.env.BODHI_CLAUDE = '/env/claude';
    expect(machine.claudePath()).toBe('/env/claude');
    // preference over env
    store['runEngine.claudePath'] = '/pref/claude';
    expect(machine.claudePath()).toBe('/pref/claude');
    clearEnv();
  });

  test('a blank preference falls through to env, and a blank env to default', () => {
    clearEnv();
    store['runEngine.ghPath'] = '   ';
    expect(machine.ghPath()).toBe('gh');
    process.env.BODHI_GH = '';
    expect(machine.ghPath()).toBe('gh');
    process.env.BODHI_GH = '/env/gh';
    expect(machine.ghPath()).toBe('/env/gh');
    clearEnv();
  });

  test('approvers split, trim, and drop empties from either source', () => {
    clearEnv();
    expect(machine.approvers()).toEqual([]);
    process.env.BODHI_APPROVERS = 'alice, bob ,, carol';
    expect(machine.approvers()).toEqual(['alice', 'bob', 'carol']);
    store['runEngine.approvers'] = 'dave';
    expect(machine.approvers()).toEqual(['dave']);
    clearEnv();
  });

  test('the prepare paths are null when unset, with bodhiRoot honouring BODHI_ROOT', () => {
    clearEnv();
    expect(machine.harnessPath()).toBeNull();
    expect(machine.bodhiRoot()).toBeNull();
    expect(machine.initiativesRoot()).toBeNull();
    process.env.BODHI_ROOT = 'C:/work/repos';
    expect(machine.bodhiRoot()).toBe('C:/work/repos');
    store['runEngine.harnessPath'] = 'C:/harness';
    expect(machine.harnessPath()).toBe('C:/harness');
    clearEnv();
  });

  test('permission posture defaults to manual, honours a valid value, and rejects an unknown one', () => {
    clearEnv();
    delete process.env.BODHI_PERMISSION_POSTURE;
    expect(machine.permissionPosture()).toBe('manual');
    store['runEngine.permissionPosture'] = 'bypass';
    expect(machine.permissionPosture()).toBe('bypass');
    store['runEngine.permissionPosture'] = 'denyOnPrompt';
    expect(machine.permissionPosture()).toBe('denyOnPrompt');
    // An unrecognized value never loosens the posture — it falls back to manual.
    store['runEngine.permissionPosture'] = 'yolo';
    expect(machine.permissionPosture()).toBe('manual');
    clearEnv();
    delete process.env.BODHI_PERMISSION_POSTURE;
  });
});
