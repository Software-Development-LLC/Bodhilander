import { afterAll, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-main-tools-')));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
const userData = path.join(base, 'userData');
const configDir = path.join(base, 'claude-accounts', 'a1', '.claude');
fs.mkdirSync(configDir, { recursive: true });

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));
mock.module('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => process.cwd(), isPackaged: false },
  Notification: class {
    show() {}
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  shell: { openExternal: async () => {} },
}));
const { crewDb, HIRE } = await import('./crew-db');
const { db, raw } = crewDb();
mock.module('../../database', () => ({ getDatabase: () => db }));
mock.module('../../repositories/accounts', () => ({ getAllAccounts: () => [{ id: 'a1', label: 'Work', email: 'crew@example.com', configDir }] }));
mock.module('../../run-engine/machine-config', () => ({ claudePath: () => 'claude', ghPath: () => 'gh' }));

const sentFiles: { jobId: string; name: string }[] = [];
const hub = Object.assign(new EventEmitter(), {
  canStart: () => true, sendReply: () => true, sendUsage: () => true, sendEdit: () => 'e', sendAudit: () => 'a',
  sendFile: async (jobId: string, file: { name: string }) => (sentFiles.push({ jobId, name: file.name }), { state: 'ack' }),
});
mock.module('../hub-service', () => ({
  startCrewHub: () => hub,
  stopCrewHub: () => {},
  getCrewHub: () => hub,
  setCrewInterrupt: () => {},
  setCrewHubReplaced: () => {},
}));
const realHost = { ...(await import('../mcp/host')) };
mock.module('../mcp/host', () => ({
  ...realHost,
  hostSocketPath: () => path.join(base, 'host.sock'),
  McpHost: class {
    ready = async () => true;
    close() {}
  },
}));
type ToolsFactory = (job: { id: string; hireId: string; scope: 'owner' | 'circle' }, threadKey: string) => {
  call(name: string, args: Record<string, unknown>): Promise<{ content: { text: string }[]; isError?: boolean }>;
};
let tools: ToolsFactory | null = null;
class ServicesNotReady extends Error {}
mock.module('../run/services', () => ({
  ServicesNotReady,
  RunServiceManager: class {
    constructor(deps: { tools: ToolsFactory }) {
      tools = deps.tools;
    }
    start = async () => ({});
    endAll() {}
  },
}));

const { startCrew, stopCrew, crewPrepareDeps } = await import('../crew-main');
const { hirePaths } = await import('../run/scope');
const { markTainted } = await import('../taint');

const ROLE_MD = '---\nrole: researcher\nfetchHosts:\n  - docs.github.com\n---\n# Researcher\n';

describe('Crew tools as the main process builds them', () => {
  test('send_file and web_fetch reach a run with their production deps', async () => {
    raw.query(`INSERT INTO crew_hire_cache (hire_id, rev, data) VALUES (?, 1, ?)`).run(HIRE, JSON.stringify({ roleId: 'researcher', accountRef: { label: 'Work', email: 'crew@example.com' } }));
    raw.query(`INSERT INTO crew_role_cache (role_id, rev, data) VALUES ('researcher', 1, ?)`).run(JSON.stringify({ role: 'researcher', roleMd: ROLE_MD }));
    const paths = hirePaths(userData, HIRE);
    fs.mkdirSync(paths.owner, { recursive: true });
    fs.writeFileSync(path.join(paths.owner, 'report.md'), 'the report');

    startCrew();
    try {
      const job = { id: 'job-1', hireId: HIRE, scope: 'owner' as const };
      await crewPrepareDeps({} as never).services(job as never, 'thread-1', 'run-1');
      expect(tools).not.toBeNull();
      const server = (tools as ToolsFactory)(job, 'thread-1');

      const sent = await server.call('send_file', { path: 'report.md', recipient: 'someone@example.com' });
      expect(sent.content[0].text).toStartWith('Sent report.md.');
      expect(sentFiles).toEqual([{ jobId: 'job-1', name: 'report.md' }]);

      const fetched = await server.call('web_fetch', { url: 'https://10.0.0.1/' });
      expect(fetched).toMatchObject({ isError: true, content: [{ text: '10.0.0.1 is not a public address.' }] });

      markTainted(db, HIRE, 'thread-1', 'message');
      const held = await server.call('web_fetch', { url: 'https://example.com/' });
      expect(held.content[0].text).toBe('This run has read untrusted content, so it can only fetch from docs.github.com.');
    } finally {
      stopCrew();
    }
  });
});
