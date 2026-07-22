import { test, expect } from 'bun:test';
import {
  isAppQuitting,
  markAppQuitting,
  shouldHideToTrayOnClose,
} from './quit-state';

test('shouldHideToTrayOnClose hides to tray when not quitting and pref is default (undefined)', () => {
  expect(shouldHideToTrayOnClose(false, undefined)).toBe(true);
});

test('shouldHideToTrayOnClose hides to tray when not quitting and pref is explicitly enabled', () => {
  expect(shouldHideToTrayOnClose(false, 'true')).toBe(true);
});

test('shouldHideToTrayOnClose does NOT hide to tray when close-to-tray disabled', () => {
  expect(shouldHideToTrayOnClose(false, 'false')).toBe(false);
});

test('shouldHideToTrayOnClose NEVER hides to tray while quitting — even with pref enabled (issue #139)', () => {
  // The core regression: quitAndInstall() closes windows then calls app.quit().
  // If close-to-tray swallowed that close, the app would never terminate and
  // Squirrel/ShipIt would wait forever ("App Still Running").
  expect(shouldHideToTrayOnClose(true, undefined)).toBe(false);
  expect(shouldHideToTrayOnClose(true, 'true')).toBe(false);
  expect(shouldHideToTrayOnClose(true, 'false')).toBe(false);
});

test('markAppQuitting latches the shared quitting flag', () => {
  // Default state (before any quit path runs) must allow normal tray behavior.
  expect(isAppQuitting()).toBe(false);
  markAppQuitting();
  expect(isAppQuitting()).toBe(true);
  // Idempotent — calling again keeps it set.
  markAppQuitting();
  expect(isAppQuitting()).toBe(true);
});
