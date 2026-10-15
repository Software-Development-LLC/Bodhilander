/**
 * Run Engine Routes
 *
 * Read-only views of what the run engine has recorded for an initiative.
 */

import { Router, Request, Response } from 'express';
import log from 'electron-log';
import * as runsRepo from '../../repositories/runs';
import { getStringParam } from '../middleware/validation';

const INITIATIVE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const ISSUE_NUMBER = /^\d{1,9}$/;

export interface RunStatusGate {
  gate: number;
  repo: string | null;
  agent: string;
  attempt: number;
  status: string;
  verdict: string | null;
  startedAt: string;
}

export interface RunStatusOwner {
  repo: string;
  branch: string;
  agent: string | null;
  state: string | null;
  blockedReason: string | null;
  mergeOrder: number | null;
  pr: { number: number | null; url: string } | null;
}

export interface RunStatusResponse {
  initiative: string;
  run: {
    id: string;
    state: string;
    kind: string;
    bootstrapState: string | null;
    blockedReason: string | null;
    createdAt: string;
    updatedAt: string;
  };
  owners: RunStatusOwner[];
  gates: RunStatusGate[];
}

/** The verdict word a finished gate recorded, without the rest of its receipt. */
function verdictOf(verdictJson: string | null): string | null {
  if (!verdictJson) return null;
  try {
    const parsed: unknown = JSON.parse(verdictJson);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { verdict?: unknown }).verdict === 'string') {
      return (parsed as { verdict: string }).verdict;
    }
  } catch {
    // An unreadable verdict is reported as absent rather than failing the view.
  }
  return null;
}

/** Only the newest attempt at each gate on each repo's track. */
function latestAttempts(gates: runsRepo.RunGateRow[]): RunStatusGate[] {
  const latest = new Map<string, runsRepo.RunGateRow>();
  for (const g of gates) {
    latest.set(`${g.repo ?? ''}\u0000${g.gate}`, g);
  }
  return [...latest.values()].map((g) => ({
    gate: g.gate,
    repo: g.repo,
    agent: g.agent,
    attempt: g.attempt,
    status: g.status,
    verdict: verdictOf(g.verdictJson),
    startedAt: g.startedAt,
  }));
}

export function buildRunStatus(run: runsRepo.RunRow): RunStatusResponse {
  return {
    initiative: run.initiativeKey,
    run: {
      id: run.id,
      state: run.state,
      kind: run.kind,
      bootstrapState: run.bootstrapState,
      blockedReason: run.blockedReason,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    },
    owners: runsRepo.listOwners(run.id).map((o) => ({
      repo: o.repo,
      branch: o.branch,
      agent: o.agent ?? null,
      state: o.state,
      blockedReason: o.blockedReason,
      mergeOrder: o.mergeOrder,
      pr: o.prUrl ? { number: o.prNumber, url: o.prUrl } : null,
    })),
    gates: latestAttempts(runsRepo.listGates(run.id)),
  };
}

export function createRunsRouter(): Router {
  const router = Router();

  /**
   * GET /runs/:key/status - Gate progress and PR links for an initiative's newest run
   */
  router.get('/:key/status', (req: Request, res: Response) => {
    let key = getStringParam(req.params.key);
    if (!ISSUE_NUMBER.test(key) && (key.length > 64 || !INITIATIVE_KEY.test(key))) {
      res.status(400).json({ error: 'Validation error', field: 'key', message: 'Expected an initiative key such as ABC-123, or its number' });
      return;
    }
    try {
      if (ISSUE_NUMBER.test(key)) {
        const keys = runsRepo.findInitiativeKeysByNumber(key);
        if (keys.length > 1) {
          res.status(409).json({ error: `Several initiatives are numbered ${key}: ${keys.join(', ')}. Pass the full key.` });
          return;
        }
        key = keys[0] ?? key;
      }
      const run = runsRepo.getLatestRunForKey(key);
      if (!run) {
        res.status(404).json({ error: `No run found for ${key}` });
        return;
      }
      res.json(buildRunStatus(run));
    } catch (error) {
      log.error('[RunsAPI] Error reading run status:', error);
      res.status(500).json({ error: 'Failed to read run status' });
    }
  });

  return router;
}
