/**
 * Hook API Routes
 *
 * Receives events from Claude Code hooks and records them as session events,
 * which power the analytics views. Hooks are configured in Claude Code to call
 * these endpoints at key moments.
 */

import { Router, Request, Response } from 'express';
import * as sessionEventsRepo from '../../repositories/session-events';
import * as sessionsRepo from '../../repositories/sessions';
import { SessionEventType } from '../../../shared/types';
import { isPathSafeConversationId } from '../../conversation-transcript';
import log from 'electron-log';

/** `startup` is the id the tab was launched with, or a nested Claude's own. */
const CONVERSATION_CHANGE_SOURCES = new Set(['resume', 'clear', 'compact']);

/**
 * Try to log a session event. Only writes if session_id references a valid session.
 */
function tryLogEvent(sessionId: string | undefined, eventType: SessionEventType, eventData?: Record<string, unknown> | null): void {
  if (!sessionId) return;
  try {
    if (!sessionsRepo.sessionExists(sessionId)) return;
    sessionEventsRepo.createEvent(sessionId, eventType, eventData);
  } catch (error) {
    log.error(`[HooksAPI] Failed to log ${eventType} event:`, error);
  }
}

/** Sanitize a value for safe logging (strip control characters, truncate). */
function sanitizeLogValue(val: unknown, maxLen = 100): string {
  const str = String(val ?? '').replace(/[\x00-\x1f\x7f]/g, '');
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * Middleware to restrict to localhost only
 */
function localhostOnly(req: Request, res: Response, next: () => void): void {
  const ip = req.socket.remoteAddress || '';
  const clientIp = ip.replace(/^::ffff:/, '');

  if (clientIp !== '127.0.0.1' && clientIp !== '::1' && clientIp !== 'localhost') {
    log.warn(`[HooksAPI] Rejected non-localhost request from: ${clientIp}`);
    res.status(403).json({ error: 'Access denied: localhost only' });
    return;
  }

  next();
}

export function createHooksRouter(): Router {
  const router = Router();

  // Apply localhost-only restriction
  router.use(localhostOnly);

  /**
   * POST /hooks/post-tool-use
   * Called by Claude Code PostToolUse hook
   */
  router.post('/post-tool-use', (req: Request, res: Response) => {
    try {
      const { tool_name, session_id } = req.body;

      log.info(`[HooksAPI] PostToolUse: ${sanitizeLogValue(tool_name)}`);

      // Log tool use event (BDHLNDR-17)
      tryLogEvent(session_id, 'tool_use', { tool_name });

      res.json({ logged: true });
    } catch (error) {
      log.error('[HooksAPI] Error processing PostToolUse:', error);
      res.status(500).json({ error: 'Failed to process hook' });
    }
  });

  /**
   * POST /hooks/stop
   * Called by Claude Code Stop hook when Claude finishes responding
   */
  router.post('/stop', (req: Request, res: Response) => {
    try {
      const {
        session_id,
        stop_reason,
        tool_uses_count,
        files_edited
      } = req.body;

      log.info(`[HooksAPI] Stop: session=${sanitizeLogValue(session_id)}, reason=${sanitizeLogValue(stop_reason)}, tools=${sanitizeLogValue(tool_uses_count)}`);

      // Log turn completion event (distinct from session_stop which means PTY exited) (BDHLNDR-17)
      tryLogEvent(session_id, 'turn_complete', {
        stop_reason,
        tool_uses_count,
        files_edited,
      });

      res.json({ logged: true });
    } catch (error) {
      log.error('[HooksAPI] Error processing Stop hook:', error);
      res.status(500).json({ error: 'Failed to process hook' });
    }
  });

  /**
   * POST /hooks/notification
   * Called when Claude sends a notification (e.g., task complete, error)
   */
  router.post('/notification', (req: Request, res: Response) => {
    try {
      const { session_id, notification_type, message } = req.body;

      log.info(`[HooksAPI] Notification: ${sanitizeLogValue(notification_type)}`);

      // Log notification event (BDHLNDR-17)
      if (notification_type === 'error') {
        tryLogEvent(session_id, 'error', { message });
      } else {
        tryLogEvent(session_id, 'notification', { type: notification_type, message });
      }

      res.json({ logged: true });
    } catch (error) {
      log.error('[HooksAPI] Error processing Notification hook:', error);
      res.status(500).json({ error: 'Failed to process hook' });
    }
  });

  /**
   * POST /hooks/session-start
   * Called by Claude Code SessionStart hook; keeps the tab's stored
   * conversation id on the one actually running in it
   */
  router.post('/session-start', (req: Request, res: Response) => {
    try {
      const { session_id, claude_session_id, source } = req.body ?? {};

      if (
        typeof session_id !== 'string'
        || typeof claude_session_id !== 'string'
        || !CONVERSATION_CHANGE_SOURCES.has(source)
        || !isPathSafeConversationId(claude_session_id)
      ) {
        res.json({ updated: false });
        return;
      }

      const session = sessionsRepo.getSession(session_id);
      if (!session || session.provider !== 'claude') {
        res.json({ updated: false });
        return;
      }

      const changed = session.claudeSessionId !== claude_session_id;
      if (changed) {
        sessionsRepo.setClaudeSessionId(session_id, claude_session_id);
        log.info(
          `[HooksAPI] SessionStart (${source}): session ${sanitizeLogValue(session_id)} moved from ` +
          `conversation ${session.claudeSessionId ?? 'none'} to ${claude_session_id}`
        );
      }

      res.json({ updated: changed });
    } catch (error) {
      log.error('[HooksAPI] Error processing SessionStart hook:', error);
      res.status(500).json({ error: 'Failed to process hook' });
    }
  });

  /**
   * GET /hooks/status
   * Check if hook API is available
   */
  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '1.0.0',
      endpoints: ['post-tool-use', 'stop', 'notification', 'session-start']
    });
  });

  return router;
}
