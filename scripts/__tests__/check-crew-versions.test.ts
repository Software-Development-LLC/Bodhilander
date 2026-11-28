import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const hook = require('../check-crew-versions.js') as ((ctx: unknown) => Promise<void>) & {
  placeholders(v: unknown): string[];
  checkCrewVersions(file: string): string | null;
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

  test('a Windows build with placeholders warns, naming each one, and still packs', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
      await expect(hook(ctx(project(shipped)))).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const said = String(warn.mock.calls[0][0]);
      expect(said).toMatch(/^WARNING/);
      expect(said).toContain('rootfs.sha256');
      expect(said).toContain('node.sha256');
      expect(said).toMatch(/can't set up Crew on Windows/);
    } finally {
      warn.mockRestore();
    }
  });

  test('a pinned Windows build, or a Mac or Linux one, packs without a warning', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(hook(ctx(project(pinned())))).resolves.toBeUndefined();
      await expect(hook(ctx(project(JSON.parse(fs.readFileSync(SHIPPED, 'utf8'))), 'darwin'))).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('with CREW_RELEASE_STRICT=1 a Windows build with placeholders fails, naming each one', async () => {
    const strict = process.env.CREW_RELEASE_STRICT;
    process.env.CREW_RELEASE_STRICT = '1';
    try {
      const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
      await expect(hook(ctx(project(shipped)))).rejects.toThrow(/rootfs\.sha256.*node\.sha256/);
      await expect(hook(ctx(project(pinned())))).resolves.toBeUndefined();
      await expect(hook(ctx(project(shipped), 'darwin'))).resolves.toBeUndefined();
    } finally {
      if (strict === undefined) delete process.env.CREW_RELEASE_STRICT;
      else process.env.CREW_RELEASE_STRICT = strict;
    }
  });

  test("the release workflow's Windows packaging is strict for a stable release only, so betas still build", () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const windows = workflow.slice(workflow.indexOf('- name: Build distributables (Windows)'), workflow.indexOf('- name: Build distributables (macOS)'));
    const strict = windows.match(/^\s+CREW_RELEASE_STRICT: (.+)$/m)?.[1];
    expect(strict).toBe("${{ needs.check-version.outputs.is_prerelease == 'false' && '1' || '' }}");
    expect(workflow).toMatch(/echo "is_prerelease=\$IS_PRERELEASE" >> \$GITHUB_OUTPUT/);
  });

  test('electron-builder runs it before packing', () => {
    expect(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')).toMatch(/^beforePack: scripts\/check-crew-versions\.js$/m);
  });
});
