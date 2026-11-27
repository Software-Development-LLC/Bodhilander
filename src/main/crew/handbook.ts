/**
 * A run's CLAUDE.md and skills/, rebuilt before every run from what the Hub
 * synced: the hire, its role, and the skill bundle the hire pins by hash.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import type { SkillFile } from './protocol';
import type { HirePaths } from './run/scope';
import { bundlePath } from './tools/server';

export const CREW_NAME = 'Bodhi Crew';

/** The run cannot be steered as the Hub says, so it does not start. */
export class SteeringUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SteeringUnavailable';
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(v).sort((a, b) => (a < b ? -1 : Number(a > b)))) out[k] = sortKeys((v as Record<string, unknown>)[k]);
  return out;
}

/** The Hub's canonical JSON: keys sorted at every depth. */
export const canonicalJson = (v: unknown): string => JSON.stringify(sortKeys(v));

export const contentHash = (body: unknown): string => createHash('sha256').update(canonicalJson(body)).digest('hex');

export interface RoleText {
  name: string | null;
  description: string | null;
  body: string;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseRoleMd(md: string): RoleText {
  const front = FRONT.exec(md);
  const field = (key: string): string | null => {
    const line = front?.[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
    const value = line?.slice(key.length + 1).trim() ?? '';
    return value === '' ? null : value;
  };
  return { name: field('name'), description: field('description'), body: (front ? md.slice(front[0].length) : md).trim() };
}

export const signature = (hireName: string): string => `— ${hireName}, AI assistant (${CREW_NAME})`;

export interface HandbookInput {
  hireName: string;
  role: RoleText;
  repos: string[];
}

export function generateHandbook(input: HandbookInput): string {
  const { hireName, role, repos } = input;
  const roleName = role.name ?? 'Crew hire';
  const repoList = repos.map((r) => '`' + r + '`').join(', ');
  const repoLine = repos.length > 0
    ? `- Repos: ${repoList}. Your GitHub access covers only these; anything else \`gh\` returns is short without an error, so say so when a list may be.`
    : '- No repos are granted to you yet. Say so in one line if a task needs one.';
  return [
    `# ${hireName}`,
    '',
    `You are ${hireName}, a ${roleName} in ${CREW_NAME}. You are an AI assistant, not a person, and you never claim otherwise.`,
    ...(role.description ? ['', role.description] : []),
    '',
    '## Objective',
    '',
    role.body,
    '',
    '## Where you work',
    '',
    repoLine,
    '- Your work folder is the current directory. Save notes and drafts there; anything outside it is refused.',
    '- Your skills are in `../skills/`. Read the one that fits before a task. To change one, propose it with the `skill_propose` tool; the owner decides, and nothing is written until then.',
    '- Notes the owner or the circle keep for you are read with `note_read` (scope `owner` or `shared`).',
    '- Bash runs in a sandbox: it reads your folder and your repos, and reaches only GitHub and the hosts your role allows.',
    '- Your instructions are all here. Never search the filesystem for your role, handbook or config.',
    '',
    '## Replies',
    '',
    '- People read you in Teams, often on a phone: the outcome in one sentence, then at most three short bullets.',
    '- Links instead of explanation. Say only what changed.',
    '- End with at most one question, answerable in a word or two. If nothing needs them, ask nothing.',
    '- To tell someone else something, use the `send` tool with their UPN.',
    '',
    '## Approvals',
    '',
    '- An action that needs approval raises a card in Teams on its own; wait for the decision and do not ask in words as well.',
    '- Never ask anyone to paste or run a command in their own terminal.',
    '- Never merge a PR, push to a default branch, or edit `.github/workflows`.',
    '',
    '## GitHub',
    '',
    `End every issue, comment and PR body you write with "${signature(hireName)}".`,
    '',
  ].join('\n');
}

type Body = Record<string, unknown>;

function row(db: Database.Database, sql: string, id: string): Body | null {
  const found = db.prepare(sql).get(id) as { data: string } | undefined;
  if (!found) return null;
  try {
    const body = JSON.parse(found.data) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Body) : null;
  } catch {
    return null;
  }
}

const hireOf = (db: Database.Database, hireId: string): Body => {
  const hire = row(db, `SELECT data FROM crew_hire_cache WHERE hire_id = ? AND rev > 0`, hireId);
  if (!hire) throw new SteeringUnavailable('the hire has not synced');
  return hire;
};

export function handbookFor(db: Database.Database, hireId: string): string {
  const hire = hireOf(db, hireId);
  const roleId = typeof hire.roleId === 'string' ? hire.roleId : '';
  const role = roleId ? row(db, `SELECT data FROM crew_role_cache WHERE role_id = ?`, roleId) : null;
  if (!role || role.deleted || typeof role.roleMd !== 'string') throw new SteeringUnavailable(`the role ${roleId || '(none)'} has not synced`);
  const repos = Array.isArray(hire.repos) ? hire.repos.filter((r): r is string => typeof r === 'string') : [];
  return generateHandbook({ hireName: typeof hire.name === 'string' ? hire.name : hireId, role: parseRoleMd(role.roleMd), repos });
}

/** The hire's pinned bundle, only when its content hashes to the pin and every path stays inside skills/. */
export function pinnedSkills(db: Database.Database, hireId: string): SkillFile[] {
  const hire = hireOf(db, hireId);
  const pin = hire.skillBundleHash;
  const id = hire.skillBundleId;
  if (typeof pin !== 'string' || typeof id !== 'string') throw new SteeringUnavailable('the hire pins no skill bundle');
  const bundle = row(db, `SELECT data FROM crew_skill_cache WHERE skill_id = ?`, id);
  if (!bundle || !Array.isArray(bundle.files)) throw new SteeringUnavailable(`the skill bundle ${id} has not been fetched`);
  if (contentHash({ role: bundle.role, files: bundle.files }) !== pin) throw new SteeringUnavailable(`the skill bundle ${id} is not the one the hire pins`);
  const files = bundle.files as unknown[];
  return files.map((f) => {
    const file = f as Partial<SkillFile>;
    const p = bundlePath(file.path);
    if (!p || typeof file.content !== 'string') throw new SteeringUnavailable(`the skill bundle ${id} has a file outside skills/`);
    return { path: p, content: file.content };
  });
}

export function restoreSkills(paths: HirePaths, files: SkillFile[]): void {
  fs.rmSync(paths.skills, { recursive: true, force: true });
  fs.mkdirSync(paths.skills, { recursive: true });
  for (const file of files) {
    const target = path.join(paths.skills, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
}
