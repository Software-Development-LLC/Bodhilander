/**
 * A one-off import of an Office employee into a hire: its skills/ become a
 * skill bundle at the Hub, its notes/ become owner/ notes, and work/ is
 * copied into the hire's owner folder. Office's folder is only ever read.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MAX_SKILL_BYTES, type SkillFile } from './protocol';
import { NOTE_MAX_CHARS } from './notes';

export const OFFICE_DATA_DIRS = (appData: string): string[] => [path.join(appData, '@bodhi-office', 'desktop')];
export const IMPORTED_WORK_DIR = 'work';
const MAX_FILES = 500;

export function findOfficeData(appData: string): string | null {
  for (const dir of OFFICE_DATA_DIRS(appData)) {
    if (fs.existsSync(path.join(dir, 'office.db')) && isDir(path.join(dir, 'employees'))) return dir;
  }
  return null;
}

function isDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Office employees with something to import, by handle. */
export function officeEmployees(dataDir: string): string[] {
  const root = path.join(dataDir, 'employees');
  if (!isDir(root)) return [];
  return fs
    .readdirSync(root)
    .filter((h) => /^[a-z0-9-]+$/.test(h) && ['skills', 'work', 'notes'].some((d) => isDir(path.join(root, h, d))))
    .sort((a, b) => a.localeCompare(b));
}

/** Regular files under dir, posix-relative, sorted; symlinks and dotfiles are never followed or read. */
function walk(dir: string, prefix = ''): string[] {
  if (!isDir(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) out.push(...walk(full, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

export interface OfficeRead {
  skills: SkillFile[];
  notes: { path: string; content: string }[];
  skipped: string[];
}

export function readOfficeEmployee(dataDir: string, handle: string): OfficeRead {
  const base = path.join(dataDir, 'employees', handle);
  const skipped: string[] = [];
  const read = (dir: string, max: number, prefix: string): { path: string; content: string }[] => {
    const files: { path: string; content: string }[] = [];
    for (const rel of walk(path.join(base, dir))) {
      const buf = fs.readFileSync(path.join(base, dir, rel));
      const content = buf.toString('utf8');
      if (buf.length > max || content.length > max || Buffer.from(content, 'utf8').compare(buf) !== 0 || files.length >= MAX_FILES) {
        skipped.push(`${prefix}${rel}`);
        continue;
      }
      files.push({ path: rel, content });
    }
    return files;
  };
  return { skills: read('skills', MAX_SKILL_BYTES, 'skills/'), notes: read('notes', NOTE_MAX_CHARS, 'notes/'), skipped };
}

/** Copy work/ under ownerDir/work, leaving anything already there in place. Returns the files copied. */
export function copyOfficeWork(dataDir: string, handle: string, ownerDir: string): number {
  const from = path.join(dataDir, 'employees', handle, 'work');
  let copied = 0;
  fs.mkdirSync(ownerDir, { recursive: true });
  for (const rel of walk(from)) {
    const parts = rel.split('/');
    const dir = realDirs(ownerDir, [IMPORTED_WORK_DIR, ...parts.slice(0, -1)]);
    if (!dir) continue;
    const target = path.join(dir, parts[parts.length - 1]);
    try {
      fs.copyFileSync(path.join(from, ...parts), target, fs.constants.COPYFILE_EXCL);
      copied += 1;
    } catch {
      // Already there, or a link the hire left in its place: keep what the hire has.
    }
  }
  return copied;
}

/** base/<parts...>, making each missing directory, or null if any part is a link or not a directory. */
function realDirs(base: string, parts: string[]): string | null {
  let at = base;
  for (const part of parts) {
    at = path.join(at, part);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(at);
    } catch {
      fs.mkdirSync(at);
      continue;
    }
    if (!stat.isDirectory()) return null;
  }
  return at;
}

export interface ImportPort {
  /** Queue a skill_bundle create for the hire; false when it could not be queued. */
  sendBundle(hireId: string, role: string, files: SkillFile[]): boolean;
  /** Queue an owner/ note write for the hire; false when it could not be queued. */
  writeOwnerNote(hireId: string, notePath: string, content: string): boolean;
}

export interface ImportSummary {
  skills: number;
  notes: number;
  work: number;
  skipped: string[];
  failed: string[];
}

export function importFromOffice(port: ImportPort, input: { dataDir: string; handle: string; hireId: string; role: string; ownerDir: string }): ImportSummary {
  const read = readOfficeEmployee(input.dataDir, input.handle);
  const failed: string[] = [];
  if (read.skills.length > 0 && !port.sendBundle(input.hireId, input.role, read.skills)) failed.push('skills');
  let notes = 0;
  for (const note of read.notes) {
    if (port.writeOwnerNote(input.hireId, `owner/${note.path}`, note.content)) notes += 1;
    else failed.push(`notes/${note.path}`);
  }
  const work = copyOfficeWork(input.dataDir, input.handle, input.ownerDir);
  return { skills: failed.includes('skills') ? 0 : read.skills.length, notes, work, skipped: read.skipped, failed };
}
