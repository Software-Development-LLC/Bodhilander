/**
 * Settings → Data: the only place the machine transfer is reachable from, and
 * the summaries that report what a restore actually did. Both were previously
 * unreachable and unreported respectively.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SettingsModal, exportSummary, importSummary } from '../SettingsModal';

const noopSub = () => () => {};

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    apiGetStatus: async () => ({ running: false }),
    apiGetPairedDevices: async () => [],
    apiHasPairingCode: async () => ({ active: false }),
    getUpdateChannel: async () => 'stable',
    getPreference: async () => null,
    setPreference: async () => {},
    getEditorOptions: async () => [],
    getLogPaths: async () => ({ logFile: '/tmp/log.txt', crashDumps: '/tmp/crash' }),
    openExternal: () => {},
    testSound: () => {},
    onPtyData: noopSub,
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('the Data section', () => {
  test('says a whole machine can move, not just groups and sessions', async () => {
    await act(async () => { render(<SettingsModal isOpen onClose={() => {}} initialTab="general" />); });

    expect(screen.getByText('Move to Another Machine:')).toBeDefined();
    expect(screen.getByText('Export…')).toBeDefined();
    expect(screen.getByText('Import…')).toBeDefined();
  });

  test('the hint names both formats, so the export prompt is not a surprise', async () => {
    await act(async () => { render(<SettingsModal isOpen onClose={() => {}} initialTab="general" />); });

    const hint = screen.getByText(/transfer bundle/i).textContent ?? '';
    expect(hint).toContain('conversation transcripts');
    expect(hint).toContain('ClaudeLander');
  });
});

describe('exportSummary', () => {
  test('quotes the archive size when one was written', () => {
    const summary = exportSummary({ success: true, groupCount: 3, sessionCount: 9, sizeLabel: '4.2 MB' });
    expect(summary).toContain('4.2 MB');
    expect(summary).toContain('3 groups and 9 sessions');
  });

  test('the portable JSON has no size to quote', () => {
    expect(exportSummary({ success: true, groupCount: 3, sessionCount: 9 }))
      .toBe('Exported 3 groups and 9 sessions.');
  });
});

describe('importSummary', () => {
  test('reports the transcripts a machine transfer carried', () => {
    const summary = importSummary({ success: true, groupCount: 2, sessionCount: 5, transcriptCount: 41 });
    expect(summary).toContain('41 conversation transcripts');
  });

  test('names how many sessions still need a folder', () => {
    const summary = importSummary({
      success: true, groupCount: 2, sessionCount: 5, transcriptCount: 41, needsRelinkCount: 3,
    });
    expect(summary).toContain('3 sessions need their folder set');
  });

  test('stays quiet about relinks when every folder was found', () => {
    const summary = importSummary({
      success: true, groupCount: 2, sessionCount: 5, transcriptCount: 41, needsRelinkCount: 0,
    });
    expect(summary).not.toContain('need their folder');
  });

  test('an older portable JSON reports neither, having carried neither', () => {
    expect(importSummary({ success: true, groupCount: 2, sessionCount: 5 }))
      .toBe('Imported 2 groups and 5 sessions.');
  });

  test('still reports what it skipped', () => {
    const summary = importSummary({
      success: true, groupCount: 0, sessionCount: 0, skippedGroups: 2, skippedSessions: 7,
    });
    expect(summary).toContain('Skipped 2 existing groups and 7 existing sessions');
  });
});
