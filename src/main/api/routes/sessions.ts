/**
 * Sessions API Routes
 *
 * CRUD operations for sessions.
 */

import { Router, Request, Response } from 'express';
import log from 'electron-log';
import * as sessionsRepo from '../../repositories/sessions';
import * as sessionEventsRepo from '../../repositories/session-events';
import * as chatEventsRepo from '../../repositories/chat-events';
import { ptyManager } from '../../pty-manager';
import { requireControlPermission, requireModifyPermission } from '../middleware/auth';
import {
  validateIdParam,
  validateCreateSession,
  validateUpdateSession,
  getStringParam,
  getStringQuery,
} from '../middleware/validation';
import { isValidUUID } from '../../validation';
import { Session } from '../../../shared/types';

const CHAT_EVENTS_DEFAULT_LIMIT = 100;
const CHAT_EVENTS_MAX_LIMIT = 500;

/**
 * Parse a `since` query value (BDHLNDR-58). Accepts either ms-epoch numeric
 * strings or ISO 8601 timestamps. Returns the parsed ms-epoch, `undefined`
 * when the caller omitted the parameter, or `null` when the value is present
 * but unparseable (caller should respond 400).
 */
function parseSinceParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  // Try numeric (ms epoch) first — covers the common case of clients echoing
  // back nextSince from a prior page.
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }
  // Fall back to ISO 8601 (or anything Date can parse).
  const asDate = new Date(raw).getTime();
  if (Number.isFinite(asDate)) {
    return asDate;
  }
  return null;
}

/**
 * Clamp a caller-supplied `limit` to [1, CHAT_EVENTS_MAX_LIMIT]. Non-numeric
 * or non-positive values fall back to the default. Returns `null` for values
 * the caller explicitly supplied but that we reject (e.g. negative numbers,
 * NaN strings) so the route can answer 400.
 */
function parseLimitParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') {
    return CHAT_EVENTS_DEFAULT_LIMIT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }
  return Math.min(Math.floor(parsed), CHAT_EVENTS_MAX_LIMIT);
}

export function createSessionsRouter(): Router {
  const router = Router();

  /**
   * GET /sessions - List all sessions
   */
  router.get('/', (_req: Request, res: Response) => {
    try {
      const sessions = sessionsRepo.getAllSessions();
      res.json({ sessions });
    } catch (error) {
      log.error('[SessionsAPI] Error listing sessions:', error);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  /**
   * GET /sessions/:id - Get a specific session
   */
  router.get('/:id', validateIdParam, (req: Request, res: Response) => {
    try {
      const sessions = sessionsRepo.getAllSessions();
      const session = sessions.find(s => s.id === req.params.id);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.json({ session });
    } catch (error) {
      log.error('[SessionsAPI] Error getting session:', error);
      res.status(500).json({ error: 'Failed to get session' });
    }
  });

  /**
   * GET /sessions/:id/chat-events - Fetch persisted chat events for a session
   *
   * BDHLNDR-58: powers the PWA chat snapshot (BDHLNDR-56) and offline cache
   * replay (BDHLNDR-59).
   *
   *   ?since  optional ms-epoch (numeric) or ISO 8601 timestamp; returns
   *           events with timestamp strictly greater than `since`.
   *   ?limit  optional, default 100, hard-capped at 500 server-side.
   *
   * Response:
   *   { events: PersistedChatEvent[],   // ascending chronological order
   *     nextSince: number | null,       // newest event ts, or null when no more pages
   *     hasMore: boolean }
   */
  router.get('/:id/chat-events', validateIdParam, (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);

      const since = parseSinceParam(getStringQuery(req.query.since));
      if (since === null) {
        res.status(400).json({
          error: 'Validation error',
          field: 'since',
          message: 'Invalid since value (expected ms epoch or ISO 8601 timestamp)',
        });
        return;
      }

      const limit = parseLimitParam(getStringQuery(req.query.limit));
      if (limit === null) {
        res.status(400).json({
          error: 'Validation error',
          field: 'limit',
          message: `Invalid limit value (expected positive integer, max ${CHAT_EVENTS_MAX_LIMIT})`,
        });
        return;
      }

      // 404 on unknown session id so callers can't probe for events of an
      // arbitrary UUID (and so they get a clear signal vs an empty array for a
      // real session that just has no events yet).
      const sessions = sessionsRepo.getAllSessions();
      const session = sessions.find(s => s.id === id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const events = chatEventsRepo.getEventsBySession(id, since, limit);

      // nextSince is the newest timestamp in this page; clients pass it back
      // as ?since= to fetch the next slice. When the page isn't full we know
      // there's nothing newer to ask for, so null it out.
      const hasMore = events.length === limit;
      const nextSince =
        hasMore && events.length > 0 ? events[events.length - 1].timestamp : null;

      res.json({ events, nextSince, hasMore });
    } catch (error) {
      log.error('[SessionsAPI] Error fetching chat events:', error);
      res.status(500).json({ error: 'Failed to fetch chat events' });
    }
  });

  /**
   * POST /sessions - Create a new session
   */
  router.post(
    '/',
    requireModifyPermission,
    validateCreateSession,
    (req: Request, res: Response) => {
      try {
        const { groupId, name, workingDir, launchClaude } = req.body;

        // Generate UUID for new session
        const id = generateUUID();
        const now = new Date();

        const session: Session = {
          id,
          groupId,
          name,
          workingDir: workingDir || process.cwd(),
          state: 'idle',
          shellType: launchClaude ? 'claude' : 'bash',
          order: getNextOrder(),
          createdAt: now,
          lastActivityAt: now,
          claudeSessionId: null,
          endedAt: null,
          durationSeconds: 0,
          claudeAccountId: null,
          provider: 'claude',
          // A brand-new session has never been failed over (#207).
          failoverFromAccountId: null,
          failoverPrevAccountId: null,
        };

        sessionsRepo.createSession(session);

        // Log session start event (BDHLNDR-17)
        try {
          sessionEventsRepo.createEvent(session.id, 'session_start', null);
        } catch (error) {
          log.error('Failed to log session_start event:', error);
        }

        // Start PTY if requested
        if (launchClaude) {
          ptyManager.createSession(id, session.workingDir, true, session.provider);
        }

        log.info(`[SessionsAPI] Created session: ${id}`);
        res.status(201).json({ session });
      } catch (error) {
        log.error('[SessionsAPI] Error creating session:', error);
        res.status(500).json({ error: 'Failed to create session' });
      }
    }
  );

  /**
   * PATCH /sessions/:id - Update a session
   */
  router.patch(
    '/:id',
    requireModifyPermission,
    validateIdParam,
    validateUpdateSession,
    (req: Request, res: Response) => {
      try {
        const id = getStringParam(req.params.id);
        const updates = req.body;

        // Check session exists
        const sessions = sessionsRepo.getAllSessions();
        const session = sessions.find(s => s.id === id);

        if (!session) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }

        sessionsRepo.updateSession(id, updates);

        log.info(`[SessionsAPI] Updated session: ${id}`);
        res.json({ success: true });
      } catch (error) {
        log.error('[SessionsAPI] Error updating session:', error);
        res.status(500).json({ error: 'Failed to update session' });
      }
    }
  );

  /**
   * DELETE /sessions/:id - Delete a session
   */
  router.delete(
    '/:id',
    requireModifyPermission,
    validateIdParam,
    async (req: Request, res: Response) => {
      try {
        const id = getStringParam(req.params.id);

        // Stop PTY if running. A kill failure aborts the delete and surfaces
        // as the 500 below; kill() already emptied its session slot, so a
        // retry skips straight to removing the record.
        if (ptyManager.getSession(id)) {
          await ptyManager.kill(id);
        }

        sessionsRepo.deleteSession(id);

        log.info(`[SessionsAPI] Deleted session: ${id}`);
        res.json({ success: true });
      } catch (error) {
        log.error('[SessionsAPI] Error deleting session:', error);
        res.status(500).json({ error: 'Failed to delete session' });
      }
    }
  );

  /**
   * POST /sessions/:id/start - Start a session's PTY
   */
  router.post(
    '/:id/start',
    requireControlPermission,
    validateIdParam,
    (req: Request, res: Response) => {
      try {
        const id = getStringParam(req.params.id);
        // A POST with no JSON body leaves req.body undefined; destructuring it
        // threw before any of the checks below could answer.
        const { launchClaude } = req.body ?? {};

        const sessions = sessionsRepo.getAllSessions();
        const session = sessions.find(s => s.id === id);

        if (!session) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }

        if (ptyManager.getSession(id)) {
          res.status(400).json({ error: 'Session is already running' });
          return;
        }

        // createSession throws on a missing cwd. Answering here instead names
        // the folder, which is the only thing that lets the owner fix it.
        if (session.workingDirMissing) {
          res.status(409).json({
            error: `Working directory not found on this machine: ${session.workingDir || '(none set)'}`,
          });
          return;
        }

        ptyManager.createSession(id, session.workingDir, launchClaude ?? false, session.provider);

        log.info(`[SessionsAPI] Started session: ${id}`);
        res.json({ success: true });
      } catch (error) {
        log.error('[SessionsAPI] Error starting session:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start session' });
      }
    }
  );

  /**
   * POST /sessions/:id/stop - Stop a session's PTY
   */
  router.post(
    '/:id/stop',
    requireControlPermission,
    validateIdParam,
    async (req: Request, res: Response) => {
      try {
        const id = getStringParam(req.params.id);

        if (!ptyManager.getSession(id)) {
          res.status(400).json({ error: 'Session is not running' });
          return;
        }

        // Settles on the real exit (force path bounds it), so success means
        // the process is gone — a client may start again on this response.
        await ptyManager.kill(id);

        log.info(`[SessionsAPI] Stopped session: ${id}`);
        res.json({ success: true });
      } catch (error) {
        log.error('[SessionsAPI] Error stopping session:', error);
        res.status(500).json({ error: 'Failed to stop session' });
      }
    }
  );

  /**
   * POST /sessions/:id/resize - Resize a session's PTY
   */
  router.post(
    '/:id/resize',
    requireControlPermission,
    validateIdParam,
    (req: Request, res: Response) => {
      try {
        const id = getStringParam(req.params.id);
        const { cols, rows } = req.body;

        if (typeof cols !== 'number' || typeof rows !== 'number' || cols < 1 || rows < 1) {
          res.status(400).json({ error: 'Invalid cols/rows values' });
          return;
        }

        if (!ptyManager.getSession(id)) {
          res.status(400).json({ error: 'Session is not running' });
          return;
        }

        ptyManager.resize(id, cols, rows);
        res.json({ success: true });
      } catch (error) {
        log.error('[SessionsAPI] Error resizing session:', error);
        res.status(500).json({ error: 'Failed to resize session' });
      }
    }
  );

  return router;
}

function generateUUID(): string {
  const { randomBytes } = require('crypto');
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function getNextOrder(): number {
  const sessions = sessionsRepo.getAllSessions();
  if (sessions.length === 0) return 0;
  return Math.max(...sessions.map(s => s.order)) + 1;
}
