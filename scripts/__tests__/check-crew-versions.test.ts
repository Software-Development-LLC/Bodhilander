import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const hook = require('../check-crew-versions.js') as ((ctx: unknown) => Promise<void>) & {
  placeholders(v: unknown): string[];
  checkCrewVersions(file: string): void;
};

const ROOT = path.join(__dirname, '..', '..');
const SHIPPED = path.join(ROOT, 'resources', 'crew-agent', 'versions.json');
const pinned = () => {
  const v = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  v.rootfs.sha256 = 'a'.repeat(64);
  v.node.sha256 = 'b'.repeat(64);
  return v;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.BODHILANDER_ALLOW_CREW_PLACEHOLDERS;
});
function project(versions: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-versions-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'resources', 'crew-agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'resources', 'crew-agent', 'versions.json'), JSON.stringify(versions));
  return dir;
}
const ctx = (projectDir: string, platform = 'win32') => ({ electronPlatformName: platform, packager: { projectDir } });

describe("the release check on Crew's versions.json", () => {
  test('names every placeholder, and a hash that is not 64 hex digits', () => {
    expect(hook.placeholders(JSON.parse(fs.readFileSync(SHIPPED, 'utf8')))).toEqual(expect.arrayContaining(['rootfs.sha256', 'node.sha256']));
    expect(hook.placeholders({ ...pinned(), node: { ...pinned().node, sha256: 'ABC' } })).toEqual(['node.sha256']);
    expect(hook.placeholders({ ...pinned(), claude: { version: 'NOT-VERIFIED-x' } })).toEqual(['claude.version']);
    expect(hook.placeholders(pinned())).toEqual([]);
  });

  test('a Windows build stops while placeholders remain, and goes on once they are pinned', async () => {
    const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
    await expect(hook(ctx(project(shipped)))).rejects.toThrow(/placeholders/);
    await expect(hook(ctx(project(pinned())))).resolves.toBeUndefined();
  });

  test('a Mac or Linux build, or a local build that opts out, is not stopped', async () => {
    const dir = project(JSON.parse(fs.readFileSync(SHIPPED, 'utf8')));
    await expect(hook(ctx(dir, 'darwin'))).resolves.toBeUndefined();
    process.env.BODHILANDER_ALLOW_CREW_PLACEHOLDERS = '1';
    await expect(hook(ctx(dir))).resolves.toBeUndefined();
  });

  test('electron-builder runs it before packing', () => {
    expect(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')).toMatch(/^beforePack: scripts\/check-crew-versions\.js$/m);
  });
});
