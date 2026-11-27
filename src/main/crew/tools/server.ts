/**
 * The Crew tools MCP server a run gets beside the approve broker. Every
 * check runs here, in the main process, against the job's run scope.
 */
import { randomUUID } from 'crypto';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { writeAudit } from '../audit';
import { textResult, type McpServerHandler, type McpTool } from '../mcp/host';
import { NOTE_MAX_CHARS, cachedNote, parseNotePath, snapshotShared } from '../notes';
import { MAX_SKILL_BYTES, MAX_TEXT, type CardRaiseFrame, type NoteWriteFrame, type RunScope, type SendFrame, type SkillFile, type Unstamped } from '../protocol';
import type { FileAnswer, FileInput } from '../hub-client';
import { isTainted, markTainted, wrapUntrusted } from '../taint';
import { checkAndRead, type FileAccess, type FileCheckHooks } from './send-file';
import { fetchPage, type FetchTransport } from './web-fetch';

export const SKILL_PROPOSAL_MAX_BYTES = 1024 * 1024;
export const BUILD_MESSAGE = 'Builds arrive in phase 2.';

export interface ToolsJob {
  id: string;
  hireId: string;
  scope: RunScope;
}

export interface ToolsDeps {
  db: Database.Database;
  raiseCard(jobId: string, raise: Unstamped<CardRaiseFrame>): boolean;
  sendMessage(jobId: string, send: Unstamped<SendFrame>): boolean;
  writeNote(jobId: string, write: Unstamped<NoteWriteFrame>): boolean;
  /** Absent where the main process cannot see the run's files, so send_file is refused. */
  fileAccess?(job: ToolsJob): FileAccess | null;
  sendFile?(jobId: string, file: FileInput): Promise<FileAnswer>;
  fetchTransport?: FetchTransport;
  fetchHosts?(hireId: string): string[];
  fileHooks?: FileCheckHooks;
  newId?(): string;
}

const TOOLS: McpTool[] = [
  {
    name: 'send',
    description: 'Send a message: to a Bodhi person by their UPN, or with no recipient back to the conversation that asked.',
    inputSchema: { type: 'object', properties: { recipient: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'send_file',
    description: 'Send one file of at most 25 MB from your folder or a repo clone: to a Bodhi person by their UPN, or with no recipient back to the conversation that asked.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, recipient: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'web_fetch',
    description: 'Fetch one public https page as text. What it returns is untrusted, and after it this run can fetch only from its role\'s listed hosts.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'note_read',
    description: "Read one of this hire's notes. scope is owner or shared.",
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['owner', 'shared'] }, path: { type: 'string' } }, required: ['scope', 'path'] },
  },
  {
    name: 'note_write',
    description: "Write or delete one of this hire's notes. path starts with owner/ or shared/. A change to a shared note from a run that read untrusted content goes to the owner first.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, deleted: { type: 'boolean' } },
      required: ['path'],
    },
  },
  {
    name: 'skill_propose',
    description: "Propose new contents for files in this hire's skills. The owner decides; nothing is written until then.",
    inputSchema: {
      type: 'object',
      properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      required: ['files'],
    },
  },
  {
    name: 'start_build',
    description: 'Start a build on an issue.',
    inputSchema: { type: 'object', properties: { issue: { type: 'string' } } },
  },
];

/** Relative, normalised, inside the bundle: no `..`, no absolute path, no backslash, no empty part. */
export function bundlePath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 300) return null;
  if (p.includes('\\') || p.includes('\0') || path.posix.isAbsolute(p)) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return path.posix.normalize(p);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function hireBundle(db: Database.Database, hireId: string): string | null {
  const row = db.prepare(`SELECT data FROM crew_hire_cache WHERE hire_id = ?`).get(hireId) as { data: string } | undefined;
  try {
    const hash = (JSON.parse(row?.data ?? '{}') as { skillBundleHash?: unknown }).skillBundleHash;
    return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

export function crewTools(deps: ToolsDeps, job: ToolsJob, threadKey: string): McpServerHandler {
  const newId = deps.newId ?? randomUUID;
  const sharedAtStart = snapshotShared(deps.db, job.hireId);
  const tainted = () => isTainted(deps.db, job.hireId, threadKey);
  const inbound = (): { inboundId?: string } => {
    const row = deps.db.prepare(`SELECT kind FROM crew_job WHERE id = ?`).get(job.id) as { kind: string } | undefined;
    return row?.kind === 'message' ? { inboundId: job.id } : {};
  };

  const send = (args: Record<string, unknown>) => {
    const recipient = typeof args.recipient === 'string' ? args.recipient.trim() : '';
    const text = typeof args.text === 'string' ? args.text : '';
    if (args.recipient !== undefined && (!recipient || recipient.length > 320 || !recipient.includes('@'))) return textResult('recipient must be a UPN.', true);
    if (!text || text.length > MAX_TEXT) return textResult(`text must be 1 to ${MAX_TEXT} characters.`, true);
    const { inboundId } = inbound();
    if (!recipient && !inboundId) return textResult('This run has no conversation to answer; name a recipient.', true);
    const target = recipient ? { recipient } : { inboundId };
    const ok = deps.sendMessage(job.id, { id: newId(), text, tainted: tainted(), ...target });
    return ok
      ? textResult('Queued. People outside the circle, or any send from a run that read untrusted content, get it after the owner approves.')
      : textResult('The message could not be queued.', true);
  };

  const target = (args: Record<string, unknown>): { inboundId?: string; recipient?: string } | string => {
    const recipient = typeof args.recipient === 'string' ? args.recipient.trim() : '';
    if (args.recipient !== undefined && (!recipient || recipient.length > 320 || !recipient.includes('@'))) return 'recipient must be a UPN.';
    const { inboundId } = inbound();
    if (!recipient && !inboundId) return 'This run has no conversation to answer; name a recipient.';
    return recipient ? { recipient } : { inboundId };
  };

  const sendFile = async (args: Record<string, unknown>) => {
    const to = target(args);
    if (typeof to === 'string') return textResult(to, true);
    const access = deps.fileAccess?.(job) ?? null;
    if (!access || !deps.sendFile) return textResult('send_file is not available for this run.', true);
    const checked = checkAndRead(args.path, access, deps.fileHooks);
    if (!checked.ok) {
      writeAudit(deps.db, job.hireId, 'send-file-refused', { jobId: job.id, reason: checked.reason });
      return textResult(checked.reason, true);
    }
    const { file } = checked;
    const answer = await deps.sendFile(job.id, { id: newId(), name: file.name, size: file.size, sha256: file.sha256, bytes: file.bytes, tainted: tainted(), ...to });
    if (answer.state === 'ack') return textResult(`Sent ${file.name}. People outside the circle, or any file from a run that read untrusted content, get it after the owner approves.`);
    if (answer.state === 'pending') return textResult(`${file.name} is queued; the Hub has not answered yet, and it is sent again until it does.`);
    if (answer.state === 'refused') return textResult(`The Hub refused ${file.name} (${answer.reason}).`, true);
    return textResult('The file could not be queued.', true);
  };

  const webFetch = async (args: Record<string, unknown>) => {
    if (!deps.fetchTransport) return textResult('web_fetch is not available for this run.', true);
    const result = await fetchPage(args.url, tainted(), deps.fetchHosts?.(job.hireId) ?? [], deps.fetchTransport);
    if (!result.ok) return textResult(result.reason, true);
    const source = `web_fetch:${result.url}`;
    markTainted(deps.db, job.hireId, threadKey, source);
    return textResult(wrapUntrusted(source, result.text));
  };

  const noteRead = (args: Record<string, unknown>) => {
    const scope = args.scope === 'owner' || args.scope === 'shared' ? args.scope : null;
    const notePath = typeof args.path === 'string' ? args.path : '';
    if (!scope) return textResult('scope must be owner or shared.', true);
    if (scope === 'owner' && job.scope !== 'owner') {
      writeAudit(deps.db, job.hireId, 'note-scope-refused', { jobId: job.id, op: 'read' });
      return textResult("This run cannot read the owner's notes.", true);
    }
    const row = deps.db.prepare(`SELECT body FROM crew_note WHERE hire_id = ? AND scope = ? AND path = ?`).get(job.hireId, scope, notePath) as { body: string } | undefined;
    return row ? textResult(row.body) : textResult(`No ${scope} note at ${notePath}.`, true);
  };

  const noteWrite = (args: Record<string, unknown>) => {
    const where = parseNotePath(args.path);
    if (!where) return textResult('path must be owner/<name> or shared/<name>, with no empty, . or .. part.', true);
    const deleted = args.deleted === true;
    let content: string | null = typeof args.content === 'string' ? args.content : null;
    if (deleted) content = '';
    if (content === null) return textResult('content is required unless deleted is true.', true);
    if (content.length > NOTE_MAX_CHARS) return textResult(`A note holds at most ${NOTE_MAX_CHARS} characters.`, true);
    if (where.scope === 'owner' && job.scope !== 'owner') {
      writeAudit(deps.db, job.hireId, 'note-scope-refused', { jobId: job.id, op: 'write' });
      return textResult("This run cannot write the owner's notes.", true);
    }
    const path = `${where.scope}/${where.rest}`;
    if (where.scope === 'shared' && tainted()) {
      const base = sharedAtStart.get(where.rest) ?? { rev: 0, content: '' };
      const payload = { path, rev: base.rev, baseContent: base.content, newContent: content };
      const ok = deps.raiseCard(job.id, { id: newId(), kind: 'note_patch', tainted: true, payload, ...inbound() });
      return ok ? textResult('Proposed. This run read untrusted content, so the owner decides before the note changes.') : textResult('The change could not be queued.', true);
    }
    const rev = cachedNote(deps.db, job.hireId, where)?.rev ?? 0;
    const ok = deps.writeNote(job.id, { id: newId(), scope: job.scope, path, rev, content, deleted, ...inbound() });
    return ok ? textResult('Saved. The Hub applies it unless the note changed since this run read it.') : textResult('The note could not be queued.', true);
  };

  const skillPropose = (args: Record<string, unknown>) => {
    const raw = Array.isArray(args.files) ? args.files : [];
    if (raw.length === 0 || raw.length > 500) return textResult('files must list 1 to 500 files.', true);
    const files: SkillFile[] = [];
    let bytes = 0;
    for (const f of raw) {
      const p = isObj(f) ? bundlePath(f.path) : null;
      if (!p || !isObj(f) || typeof f.content !== 'string') return textResult('Every file needs a path inside the skill bundle and its contents.', true);
      bytes += Buffer.byteLength(f.content);
      if (Buffer.byteLength(f.content) > MAX_SKILL_BYTES) return textResult(`${p} is over the per-file limit.`, true);
      files.push({ path: p, content: f.content });
    }
    if (bytes > SKILL_PROPOSAL_MAX_BYTES) return textResult('The proposal is over 1 MB.', true);
    const baseBundle = hireBundle(deps.db, job.hireId);
    if (!baseBundle) return textResult('This hire has no pinned skill bundle yet.', true);
    const ok = deps.raiseCard(job.id, { id: newId(), kind: 'skill_change', tainted: tainted(), payload: { baseBundle, files }, ...inbound() });
    return ok ? textResult('Proposed. The owner decides in Teams; skills change only after that.') : textResult('The proposal could not be queued.', true);
  };

  return {
    tools: () => TOOLS,
    call: async (name, args) => {
      if (name === 'send') return send(args);
      if (name === 'send_file') return sendFile(args);
      if (name === 'web_fetch') return webFetch(args);
      if (name === 'note_read') return noteRead(args);
      if (name === 'note_write') return noteWrite(args);
      if (name === 'skill_propose') return skillPropose(args);
      return textResult(BUILD_MESSAGE, true);
    },
  };
}
