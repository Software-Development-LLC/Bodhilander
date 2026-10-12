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

const sent: string[] = [];

function buildMenu(): void {
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel: string) => { sent.push(channel); } },
  } as never;
  createApplicationMenu(fakeWindow);
}

/**
 * The app menu is macOS-only, so everything it holds has to be mirrored
 * elsewhere off macOS. Building under a forced platform is the only way to see
 * that other branch from here.
 */
function sessionMenuOn(platform: string): MenuItem[] {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    buildMenu();
    return template.find((m) => m.label === 'Session')?.submenu ?? [];
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
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

describe('reaching Settings without the macOS app menu', () => {
  for (const platform of ['win32', 'linux']) {
    test(`${platform} shows Settings in a menu rather than hiding it behind a chord`, () => {
      const item = sessionMenuOn(platform).find((i) => i.label?.startsWith('Settings'));

      expect(item).toBeDefined();
      // The bug was an item that existed only to register its accelerator, so
      // asserting it exists proves nothing on its own.
      expect((item as { visible?: boolean }).visible).not.toBe(false);

      sent.length = 0;
      item!.click!();
      expect(sent).toContain('open-settings');
    });
  }

  test('macOS keeps it in the app menu and does not duplicate it into Session', () => {
    const labels = sessionMenuOn('darwin').map((i) => i.label);
    expect(labels.filter((l) => l?.startsWith('Settings'))).toHaveLength(0);

    const appMenu = template.find((m) => m.label === 'Bodhilander')?.submenu ?? [];
    expect(appMenu.map((i) => i.label)).toContain('Preferences...');
  });
});
