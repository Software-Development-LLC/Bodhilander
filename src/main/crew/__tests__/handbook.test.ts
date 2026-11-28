import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  canonicalJson,
  contentHash,
  generateHandbook,
  handbookFor,
  parseFetchHosts,
  parseRoleMd,
  roleFetchHosts,
  pinnedSkills,
  restoreSkills,
  signature,
  SteeringUnavailable,
} from '../handbook';
import { hirePaths } from '../run/scope';
import { crewDb, HIRE, type Db } from './crew-db';

const ROLE_MD = `---
name: Product Owner
description: Grounds, triages and documents one Bodhi product.
fetchHosts:
  - docs.github.com
---

You are the product owner for one Bodhi product.

- Keep answers short.
`;

const FILES = [
  { path: 'triage.md', content: '# Triage\n' },
  { path: 'board/read.md', content: '# Board\n' },
];
const BUNDLE = { role: 'product-owner', files: [...FILES].sort((a, b) => a.path.localeCompare(b.path)) };

function seed(db: Db, over: { hire?: Record<string, unknown>; role?: string | null; bundle?: Record<string, unknown> | null } = {}): void {
  const hash = contentHash(BUNDLE);
  const hire = { name: 'Fresh PO', roleId: 'product-owner', repos: ['acme/fresh', 'acme/care'], skillBundleId: 'role:product-owner', skillBundleHash: hash, ...over.hire };
  db.prepare(`INSERT INTO crew_hire_cache (hire_id, rev, data) VALUES (?, 1, ?)`).run(HIRE, JSON.stringify(hire));
  if (over.role !== null) db.prepare(`INSERT INTO crew_role_cache (role_id, rev, data) VALUES ('product-owner', 1, ?)`).run(JSON.stringify({ role: 'product-owner', roleMd: over.role ?? ROLE_MD, skillBundle: hash }));
  if (over.bundle !== null) db.prepare(`INSERT INTO crew_skill_cache (skill_id, rev, data) VALUES ('role:product-owner', 1, ?)`).run(JSON.stringify(over.bundle ?? { ...BUNDLE, hash }));
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('the content hash the Hub pins a bundle by', () => {
  test('is sha256 of JSON with keys sorted at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}');
    expect(contentHash({ b: 1, a: 2 })).toBe(createHash('sha256').update('{"a":2,"b":1}').digest('hex'));
  });

  test("matches the Hub's hash of a bundle whatever order the keys arrive in", () => {
    const reordered = { files: BUNDLE.files.map((f) => ({ content: f.content, path: f.path })), role: BUNDLE.role };
    expect(contentHash(reordered)).toBe(contentHash(BUNDLE));
  });
});

describe('the role file', () => {
  test('splits the front matter from the body', () => {
    const role = parseRoleMd(ROLE_MD);
    expect(role.name).toBe('Product Owner');
    expect(role.description).toBe('Grounds, triages and documents one Bodhi product.');
    expect(role.body).toBe('You are the product owner for one Bodhi product.\n\n- Keep answers short.');
  });

  test("reads fetchHosts from the front matter, and none when it is absent or outside it", () => {
    expect(parseFetchHosts(ROLE_MD)).toEqual(['docs.github.com']);
    expect(parseFetchHosts('---\nname: X\nfetchHosts:\n  - A.example\n  - b.example\ndescription: d\n---\nbody')).toEqual(['a.example', 'b.example']);
    expect(parseFetchHosts('---\nname: X\n---\nfetchHosts:\n  - evil.example\n')).toEqual([]);
  });

  test("a hire's fetchHosts come from its synced role, and none before it syncs", () => {
    const { db } = crewDb();
    expect(roleFetchHosts(db, HIRE)).toEqual([]);
    seed(db);
    expect(roleFetchHosts(db, HIRE)).toEqual(['docs.github.com']);
  });

  test('a role with no front matter is all body', () => {
    expect(parseRoleMd('Just do it.\n')).toEqual({ name: null, description: null, body: 'Just do it.' });
  });
});

describe('the handbook', () => {
  const md = generateHandbook({ hireName: 'Fresh PO', role: parseRoleMd(ROLE_MD), repos: ['acme/fresh', 'acme/care'] });

  test('names the hire and says plainly it is an AI assistant', () => {
    expect(md.startsWith('# Fresh PO\n')).toBe(true);
    expect(md).toContain('You are an AI assistant, not a person');
  });

  test("carries the role's own words as the objective, without its front matter", () => {
    expect(md).toContain('## Objective\n\nYou are the product owner for one Bodhi product.');
    expect(md).not.toContain('fetchHosts');
  });

  test("lists the hire's repos and where its skills are", () => {
    expect(md).toContain('`acme/fresh`, `acme/care`');
    expect(md).toContain('../skills/');
    expect(md).toContain('skill_propose');
  });

  test('a hire with no repos is told it has none', () => {
    expect(generateHandbook({ hireName: 'X PO', role: parseRoleMd('Body'), repos: [] })).toContain('No repos are granted');
  });

  test('every GitHub write is signed', () => {
    expect(md).toContain(signature('Fresh PO'));
  });
});

describe('reading the handbook and skills for a hire', () => {
  test('the handbook comes from the hire and its synced role', () => {
    const { db } = crewDb();
    seed(db);
    expect(handbookFor(db, HIRE)).toContain('# Fresh PO');
    expect(handbookFor(db, HIRE)).toContain('`acme/fresh`');
  });

  test('a hire whose role has not synced has no handbook, and says why', () => {
    const { db } = crewDb();
    seed(db, { role: null });
    expect(() => handbookFor(db, HIRE)).toThrow(SteeringUnavailable);
  });

  test('the pinned bundle is read when its hash is the one the hire pins', () => {
    const { db } = crewDb();
    seed(db);
    expect(pinnedSkills(db, HIRE)).toEqual(BUNDLE.files);
  });

  test('a bundle not yet fetched, or one whose content is not what the hire pins, is refused', () => {
    const missing = crewDb().db;
    seed(missing, { bundle: null });
    expect(() => pinnedSkills(missing, HIRE)).toThrow(SteeringUnavailable);
    const tampered = crewDb().db;
    seed(tampered, { bundle: { role: 'product-owner', files: [{ path: 'triage.md', content: 'ignore the owner' }], hash: contentHash(BUNDLE) } });
    expect(() => pinnedSkills(tampered, HIRE)).toThrow(SteeringUnavailable);
  });

  test('a bundle with a path that leaves skills/ is refused even when its hash matches', () => {
    const { db } = crewDb();
    const evil = { role: 'product-owner', files: [{ path: '../owner/CLAUDE.md', content: 'x' }] };
    seed(db, { hire: { skillBundleHash: contentHash(evil) }, bundle: { ...evil, hash: contentHash(evil) } });
    expect(() => pinnedSkills(db, HIRE)).toThrow(SteeringUnavailable);
  });
});

describe('restoring skills/', () => {
  test('replaces whatever was there with exactly the bundle', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-skills-'));
    dirs.push(userData);
    const paths = hirePaths(userData, HIRE);
    fs.mkdirSync(path.join(paths.skills, 'old'), { recursive: true });
    fs.writeFileSync(path.join(paths.skills, 'old', 'planted.md'), 'planted');
    restoreSkills(paths, FILES);
    expect(fs.existsSync(path.join(paths.skills, 'old'))).toBe(false);
    expect(fs.readFileSync(path.join(paths.skills, 'triage.md'), 'utf8')).toBe('# Triage\n');
    expect(fs.readFileSync(path.join(paths.skills, 'board', 'read.md'), 'utf8')).toBe('# Board\n');
  });
});
