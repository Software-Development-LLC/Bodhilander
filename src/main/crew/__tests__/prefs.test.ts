import { describe, expect, test } from 'bun:test';
import { rendererMayWritePreference } from '../prefs';

describe('preferences the renderer may write', () => {
  test('every crew.* key is main-only; other keys stay writable', () => {
    for (const key of ['crew.hubUrl', 'crew.machineId', 'crew.anything']) expect(rendererMayWritePreference(key)).toBe(false);
    for (const key of ['autoLaunchClaude', 'crewish', 'theme']) expect(rendererMayWritePreference(key)).toBe(true);
  });
});
