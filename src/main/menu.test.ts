/**
 * The menu is the only entry point to import/export that does not require
 * finding a Settings tab first. These pin that the items exist and that
 * clicking one really reaches the exporter, rather than being inert labels.
 */
import { describe, expect, mock, test } from 'bun:test';

type MenuItem = { label?: string; type?: string; click?: () => void; submenu?: MenuItem[] };

let template: MenuItem[] = [];
const messageBoxes: { message?: string }[] = [];
const openDialogs: unknown[] = [];

mock.module('electron', () => ({
  app: { name: 'Bodhilander', getVersion: () => '3.5.1', getPath: () => '/nonexistent-test-userdata' },
  shell: { openExternal: () => {} },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: class {},
  Menu: {
    buildFromTemplate: (t: MenuItem[]) => { template = t; return {}; },
    setApplicationMenu: () => {},
  },
  dialog: {
    // Cancel at the first question: the click only has to prove it got here.
    showMessageBox: async (opts: { message?: string }) => {
      messageBoxes.push(opts);
      return { response: 2 };
    },
    showOpenDialog: async (opts: unknown) => {
      openDialogs.push(opts);
      return { canceled: true, filePaths: [] };
    },
  },
}));

const { createApplicationMenu } = await import('./menu');

function buildMenu(): void {
  const fakeWindow = { webContents: { send: () => {} } } as never;
  createApplicationMenu(fakeWindow);
}

function sessionMenu(): MenuItem[] {
  buildMenu();
  return template.find((m) => m.label === 'Session')?.submenu ?? [];
}

function itemLabelled(label: string): MenuItem {
  return sessionMenu().find((i) => i.label === label)!;
}

describe('the Session menu', () => {
  test('offers both halves of the machine transfer', () => {
    const labels = sessionMenu().map((i) => i.label);
    expect(labels).toContain('Export…');
    expect(labels).toContain('Import…');
  });

  test('Export… reaches the exporter and is asked what to carry', async () => {
    messageBoxes.length = 0;
    itemLabelled('Export…').click!();
    await new Promise((r) => setTimeout(r, 10));

    expect(messageBoxes).toHaveLength(1);
    expect(messageBoxes[0].message).toBe('What should the export carry?');
  });

  test('Import… reaches the importer and opens a file picker', async () => {
    openDialogs.length = 0;
    itemLabelled('Import…').click!();
    await new Promise((r) => setTimeout(r, 10));

    expect(openDialogs).toHaveLength(1);
  });

  test('neither carries an accelerator, so no terminal key is spent on them', () => {
    for (const label of ['Export…', 'Import…']) {
      expect((itemLabelled(label) as { accelerator?: string }).accelerator).toBeUndefined();
    }
  });
});
