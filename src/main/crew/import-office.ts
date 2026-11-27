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
const WORK_DIRS = ['work', 'work-from-office'];
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

/**
 * Copy work/ into ownerDir/work, or work-from-office when the hire already has a work/.
 * The copy is built beside ownerDir, where a run cannot write, then renamed in whole,
 * so nothing the hire plants under ownerDir is followed. Null when neither name is free.
 */
export function copyOfficeWork(dataDir: string, handle: string, ownerDir: string): number | null {
  const from = path.join(dataDir, 'employees', handle, 'work');
  const files = walk(from);
  if (files.length === 0) return 0;
  fs.mkdirSync(ownerDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(ownerDir), '.office-'));
  try {
    for (const rel of files) {
      const parts = rel.split('/');
      fs.mkdirSync(path.join(staging, ...parts.slice(0, -1)), { recursive: true });
      fs.copyFileSync(path.join(from, ...parts), path.join(staging, ...parts));
    }
    for (const name of WORK_DIRS) {
      try {
        fs.renameSync(staging, path.join(ownerDir, name));
        return files.length;
      } catch {
        // Taken by the hire: try the next name.
      }
    }
    return null;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
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
  if (work === null) failed.push('work/');
  return { skills: failed.includes('skills') ? 0 : read.skills.length, notes, work: work ?? 0, skipped: read.skipped, failed };
}
