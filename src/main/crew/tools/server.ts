/**
 * The Crew tools MCP server a run gets beside the approve broker. Every
 * check runs here, in the main process, against the job's run scope.
 */
import { randomUUID } from 'crypto';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { writeAudit } from '../audit';
import { textResult, type McpServerHandler, type McpTool } from '../mcp/host';
import { MAX_SKILL_BYTES, MAX_TEXT, type CardRaiseFrame, type RunScope, type SkillFile } from '../protocol';
import { isTainted } from '../taint';

export const SKILL_PROPOSAL_MAX_BYTES = 1024 * 1024;
export const BUILD_MESSAGE = 'Builds arrive in phase 2.';

export interface ToolsJob {
  id: string;
  hireId: string;
  scope: RunScope;
}

export interface ToolsDeps {
  db: Database.Database;
  raiseCard(jobId: string, raise: Omit<CardRaiseFrame, 'type' | 'hireId' | 'epoch'>): boolean;
  newId?(): string;
}

const TOOLS: McpTool[] = [
  {
    name: 'send',
    description: 'Send a message to a Bodhi person by their UPN. The owner approves it in Teams first.',
    inputSchema: { type: 'object', properties: { recipient: { type: 'string' }, text: { type: 'string' } }, required: ['recipient', 'text'] },
  },
  {
    name: 'note_read',
    description: "Read one of this hire's notes. scope is owner or shared.",
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['owner', 'shared'] }, path: { type: 'string' } }, required: ['scope', 'path'] },
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
  const tainted = () => isTainted(deps.db, job.hireId, threadKey);
  const inbound = (): { inboundId?: string } => {
    const row = deps.db.prepare(`SELECT kind FROM crew_job WHERE id = ?`).get(job.id) as { kind: string } | undefined;
    return row?.kind === 'message' ? { inboundId: job.id } : {};
  };

  const send = (args: Record<string, unknown>) => {
    const recipient = typeof args.recipient === 'string' ? args.recipient.trim() : '';
    const text = typeof args.text === 'string' ? args.text : '';
    if (!recipient || recipient.length > 320 || !recipient.includes('@')) return textResult('recipient must be a UPN.', true);
    if (!text || text.length > MAX_TEXT) return textResult(`text must be 1 to ${MAX_TEXT} characters.`, true);
    const ok = deps.raiseCard(job.id, { id: newId(), kind: 'outbound', tainted: tainted(), payload: { recipient, text }, ...inbound() });
    return ok ? textResult('Sent to the owner for approval in Teams.') : textResult('The message could not be queued.', true);
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
      if (name === 'note_read') return noteRead(args);
      if (name === 'skill_propose') return skillPropose(args);
      return textResult(BUILD_MESSAGE, true);
    },
  };
}
