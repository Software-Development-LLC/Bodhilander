/**
 * Terminal Routes
 *
 * REST API endpoints for terminal operations.
 */

import { Router, Request, Response } from 'express';
import { ptyManager } from '../../pty-manager';

export function createTerminalRouter(): Router {
  const router = Router();

  /**
   * POST /api/v1/terminal/:sessionId/input
   * Send input to terminal
   */
  router.post('/:sessionId/input', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const { data } = req.body;

    if (!data || typeof data !== 'string') {
      res.status(400).json({ error: 'Missing or invalid input data' });
      return;
    }

    const session = ptyManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    ptyManager.write(sessionId, data);
    res.json({ success: true });
  });

  /**
   * POST /api/v1/terminal/:sessionId/resize
   * Resize terminal
   */
  router.post('/:sessionId/resize', (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const { cols, rows } = req.body;

    if (!cols || !rows || typeof cols !== 'number' || typeof rows !== 'number') {
      res.status(400).json({ error: 'Missing or invalid cols/rows' });
      return;
    }

    const session = ptyManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    ptyManager.resize(sessionId, cols, rows);
    res.json({ success: true });
  });

  /**
   * GET /api/v1/terminal/:sessionId/buffer
   * Get terminal scrollback buffer (recent output history)
   */
  router.get('/:sessionId/buffer', (req: Request, res: Response) => {
    const { sessionId } = req.params;

    const session = ptyManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const buffer = ptyManager.getBuffer(sessionId);
    res.json({ buffer });
  });

  return router;
}
