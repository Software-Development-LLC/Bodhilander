import React from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClaudeDesktopActionResult, ClaudeDesktopStatus } from '../../../shared/types';
import { ClaudeDesktopSettings } from '../ClaudeDesktopSettings';

const OFF: ClaudeDesktopStatus = { enabled: false, deviceId: null, apiRunning: true, port: 8443, extensionAvailable: true };
const ON: ClaudeDesktopStatus = { ...OFF, enabled: true, deviceId: 'd1' };

let calls: string[];
let initial: ClaudeDesktopStatus;
let next: ClaudeDesktopActionResult;

beforeEach(() => {
  calls = [];
  initial = OFF;
  next = { success: true, status: ON };
  const action = (name: string) => async () => { calls.push(name); return next; };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    claudeDesktopGetStatus: async () => initial,
    claudeDesktopEnable: action('enable'),
    claudeDesktopDisable: action('disable'),
    claudeDesktopInstall: action('install'),
    claudeDesktopSaveExtension: action('save'),
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function open() {
  await act(async () => { render(<ClaudeDesktopSettings />); });
}

const checkbox = () => screen.getByRole('checkbox') as HTMLInputElement;

describe('access', () => {
  test('turning it on enables access and shows the new state', async () => {
    await open();
    expect(checkbox().checked).toBe(false);
    await act(async () => { fireEvent.click(checkbox()); });
    expect(calls).toEqual(['enable']);
    expect(checkbox().checked).toBe(true);
    expect(screen.queryByText('Enabled') !== null).toBe(true);
  });

  test('turning it off disables access', async () => {
    initial = ON;
    next = { success: true, status: OFF };
    await open();
    await act(async () => { fireEvent.click(checkbox()); });
    expect(calls).toEqual(['disable']);
    expect(checkbox().checked).toBe(false);
  });

  test('a failure is shown, not swallowed', async () => {
    next = { success: false, error: 'The local API server could not start: EACCES' };
    await open();
    await act(async () => { fireEvent.click(checkbox()); });
    expect(screen.queryByText('The local API server could not start: EACCES') !== null).toBe(true);
  });

  test('warns when access is on but the API server is stopped', async () => {
    initial = { ...ON, apiRunning: false };
    await open();
    expect(screen.queryByText(/cannot reach Bodhilander/) !== null).toBe(true);
  });
});

describe('extension', () => {
  test('install and save each go to their own handler', async () => {
    next = { success: true, status: OFF, message: 'Saved to /tmp/bodhilander.mcpb' };
    await open();
    await act(async () => { fireEvent.click(screen.getByText('Install in Claude Desktop')); });
    await act(async () => { fireEvent.click(screen.getByText('Save extension file…')); });
    expect(calls).toEqual(['install', 'save']);
    expect(screen.queryByText('Saved to /tmp/bodhilander.mcpb') !== null).toBe(true);
  });

  test('a build without the extension says so instead of offering buttons', async () => {
    initial = { ...OFF, extensionAvailable: false };
    await open();
    expect(screen.queryByText('Install in Claude Desktop')).toBeNull();
    expect(screen.queryByText(/does not include the Claude Desktop extension/) !== null).toBe(true);
  });
});
