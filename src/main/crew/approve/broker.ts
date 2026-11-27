/**
 * The approve broker behind --permission-prompt-tool. A request raises a
 * `permission` card through the Hub and holds the run for 120 s; with no
 * decision by then the run parks, and a later decision resumes it as a job.
 */
import { createHash, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { writeAudit } from '../audit';
import { textResult, type McpServerHandler } from '../mcp/host';
import type { CardDecisionFrame, PermissionPayload, RunScope } from '../protocol';
import { isTainted } from '../taint';

export const CARD_HOLD_MS = 120_000;
export const APPROVE_TOOL = 'approve';
export const SUMMARY_MAX = 4000;
export const PARKED_MESSAGE =
  "This needs the owner's approval, and it is waiting on them as a card. Stop here and say you are waiting; you will be resumed when they decide.";
export const DENIED_MESSAGE = 'The owner denied this.';
export const UNRAISED_MESSAGE = 'This needs approval, and the request could not be sent. Stop here and say so.';

export interface ApproveRun {
  jobId: string;
  hireId: string;
  threadKey: string;
  scope: RunScope;
  requestedBy: string;
}

export interface CardRaise {
  kind: 'permission';
  payload: PermissionPayload;
  tainted: boolean;
}

export interface BrokerDeps {
  db: Database.Database;
  /** Queue the card_raise for this job; the raise id, or null when the job is fenced or gone. */
  raiseCard(jobId: string, raiseId: string, raise: CardRaise): boolean;
  park(jobId: string): void;
  holdMs?: number;
  newId?(): string;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

type Decision = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };

interface Waiter {
  input: Record<string, unknown>;
  settle(d: Decision): void;
  timer: unknown;
}

export function inputHash(tool: string, input: unknown): string {
  return createHash('sha256').update(JSON.stringify([tool, input ?? null])).digest('hex');
}

export function permissionSummary(tool: string, input: unknown): string {
  const text = `${tool} ${JSON.stringify(input ?? {})}`;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

export function decisionText(tool: string | null, decision: CardDecisionFrame['decision']): string {
  const what = tool ? `the ${tool} call you asked about` : 'your request';
  return decision === 'approved'
    ? `The owner approved ${what}. Carry on from where you stopped.`
    : `The owner denied ${what}. Carry on without it.`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface CardRow {
  raise_id: string;
  job_id: string;
  hire_id: string;
  thread_key: string;
  scope: RunScope;
  requested_by: string;
  tool: string | null;
  state: string;
}

export class ApproveBroker {
  private readonly waiting = new Map<string, Waiter>();
  private readonly holdMs: number;
  private readonly newId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: BrokerDeps) {
    this.holdMs = deps.holdMs ?? CARD_HOLD_MS;
    this.newId = deps.newId ?? randomUUID;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  handler(run: ApproveRun): McpServerHandler {
    return {
      tools: () => [
        {
          name: APPROVE_TOOL,
          description: "Ask the hire's owner to approve a tool call.",
          inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } } },
        },
      ],
      call: async (_name, args) => textResult(JSON.stringify(await this.ask(run, args))),
    };
  }

  /** An approval decided after a park is spent once, on the same call when the resumed run repeats it. */
  private takeGrant(run: ApproveRun, hash: string): boolean {
    const used = this.deps.db
      .prepare(
        `UPDATE crew_card SET state = 'used' WHERE raise_id = (
           SELECT raise_id FROM crew_card WHERE hire_id = ? AND thread_key = ? AND input_hash = ? AND state = 'decided' AND decision = 'approved'
           ORDER BY created_at LIMIT 1)`,
      )
      .run(run.hireId, run.threadKey, hash);
    return used.changes > 0;
  }

  ask(run: ApproveRun, args: Record<string, unknown>): Promise<Decision> {
    const tool = typeof args.tool_name === 'string' && args.tool_name ? args.tool_name : 'unknown';
    const input = isRecord(args.input) ? args.input : {};
    const hash = inputHash(tool, input);
    if (this.takeGrant(run, hash)) {
      writeAudit(this.deps.db, run.hireId, 'permission-granted', { jobId: run.jobId, tool });
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const raiseId = this.newId();
    const tainted = isTainted(this.deps.db, run.hireId, run.threadKey);
    this.deps.db
      .prepare(
        `INSERT INTO crew_card (raise_id, job_id, hire_id, thread_key, scope, requested_by, kind, tool, input_hash)
         VALUES (?, ?, ?, ?, ?, ?, 'permission', ?, ?)`,
      )
      .run(raiseId, run.jobId, run.hireId, run.threadKey, run.scope, run.requestedBy, tool, hash);
    const raised = this.deps.raiseCard(run.jobId, raiseId, { kind: 'permission', payload: { tool, summary: permissionSummary(tool, input) }, tainted });
    if (!raised) {
      this.deps.db.prepare(`DELETE FROM crew_card WHERE raise_id = ?`).run(raiseId);
      return Promise.resolve({ behavior: 'deny', message: UNRAISED_MESSAGE });
    }
    writeAudit(this.deps.db, run.hireId, 'permission-asked', { jobId: run.jobId, raiseId, tool });
    return new Promise((resolve) => {
      const waiter: Waiter = {
        input,
        settle: (d) => {
          this.clearTimer(waiter.timer);
          this.waiting.delete(raiseId);
          resolve(d);
        },
        timer: null,
      };
      waiter.timer = this.setTimer(() => {
        this.deps.db.prepare(`UPDATE crew_card SET state = 'parked' WHERE raise_id = ? AND state = 'waiting'`).run(raiseId);
        writeAudit(this.deps.db, run.hireId, 'run-parked', { jobId: run.jobId, raiseId });
        this.deps.park(run.jobId);
        waiter.settle({ behavior: 'deny', message: PARKED_MESSAGE });
      }, this.holdMs);
      this.waiting.set(raiseId, waiter);
    });
  }

  /**
   * A decision on a held run answers it; on a parked one (or one raised before a restart)
   * it becomes a `card` job on the parked job's thread and scope. Null when nothing matches.
   */
  decide(frame: CardDecisionFrame): 'answered' | 'job' | null {
    const db = this.deps.db;
    const card = db.prepare(`SELECT * FROM crew_card WHERE raise_id = ? AND hire_id = ?`).get(frame.raiseId, frame.hireId) as CardRow | undefined;
    if (!card || (card.state !== 'waiting' && card.state !== 'parked')) {
      writeAudit(db, frame.hireId, 'card-decision-ignored', { raiseId: frame.raiseId, known: !!card });
      return null;
    }
    const waiter = this.waiting.get(card.raise_id);
    if (waiter && card.state === 'waiting') {
      db.prepare(`UPDATE crew_card SET state = 'used', decision = ? WHERE raise_id = ?`).run(frame.decision, card.raise_id);
      waiter.settle(frame.decision === 'approved' ? { behavior: 'allow', updatedInput: waiter.input } : { behavior: 'deny', message: DENIED_MESSAGE });
      return 'answered';
    }
    db.transaction(() => {
      db.prepare(`UPDATE crew_card SET state = 'decided', decision = ?, decision_job_id = ? WHERE raise_id = ?`).run(frame.decision, frame.id, card.raise_id);
      db.prepare(
        `INSERT OR IGNORE INTO crew_job (id, hire_id, kind, epoch, scope, requested_by, sender, text) VALUES (?, ?, 'card', ?, ?, ?, ?, ?)`,
      ).run(frame.id, card.hire_id, frame.epoch, card.scope, card.requested_by, frame.decidedBy, decisionText(card.tool, frame.decision));
      db.prepare(`UPDATE crew_job SET state = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'parked'`).run(card.job_id);
    })();
    return 'job';
  }

  /** The thread a card job resumes: the one its parked job ran on. */
  threadOf(jobId: string): string | null {
    const row = this.deps.db.prepare(`SELECT thread_key FROM crew_card WHERE decision_job_id = ?`).get(jobId) as { thread_key: string } | undefined;
    return row?.thread_key ?? null;
  }

  /** A run that ended stops waiting; its open card stays open as parked. */
  release(jobId: string): void {
    const rows = this.deps.db.prepare(`SELECT raise_id FROM crew_card WHERE job_id = ? AND state = 'waiting'`).all(jobId) as { raise_id: string }[];
    for (const { raise_id: raiseId } of rows) {
      this.deps.db.prepare(`UPDATE crew_card SET state = 'parked' WHERE raise_id = ?`).run(raiseId);
      this.waiting.get(raiseId)?.settle({ behavior: 'deny', message: PARKED_MESSAGE });
    }
  }

  stop(): void {
    for (const w of [...this.waiting.values()]) w.settle({ behavior: 'deny', message: PARKED_MESSAGE });
  }
}
