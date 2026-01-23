/**
 * Memory API Routes
 *
 * Provides REST endpoints for memory operations.
 * Used by the MCP server to access memories without native module dependencies.
 */

import { Router, Request, Response } from 'express';
import * as memoriesRepo from '../../repositories/memories';
import * as groupsRepo from '../../repositories/groups';
import { MemoryType } from '../../../shared/types';
import { getStringParam } from '../middleware/validation';
import log from 'electron-log';

/**
 * Middleware to restrict to localhost only (for MCP server)
 */
function localhostOnly(req: Request, res: Response, next: () => void): void {
  const ip = req.socket.remoteAddress || '';
  const clientIp = ip.replace(/^::ffff:/, '');

  if (clientIp !== '127.0.0.1' && clientIp !== '::1' && clientIp !== 'localhost') {
    log.warn(`[MemoriesAPI] Rejected non-localhost request from: ${clientIp}`);
    res.status(403).json({ error: 'Access denied: localhost only' });
    return;
  }

  next();
}

export function createMemoriesRouter(): Router {
  const router = Router();

  // Apply localhost-only restriction to all memory routes
  router.use(localhostOnly);

  /**
   * GET /memories
   * List memories with optional filters
   */
  router.get('/', (req: Request, res: Response) => {
    try {
      const { group_id, type, limit } = req.query;

      const memories = memoriesRepo.getMemoriesByGroup(
        group_id as string | undefined,
        type as MemoryType | undefined,
        limit ? parseInt(limit as string, 10) : 50
      );

      res.json({ memories });
    } catch (error) {
      log.error('[MemoriesAPI] Error listing memories:', error);
      res.status(500).json({ error: 'Failed to list memories' });
    }
  });

  /**
   * GET /memories/search
   * Search memories by query
   */
  router.get('/search', (req: Request, res: Response) => {
    try {
      const { q, group_id, type, limit } = req.query;

      if (!q) {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
      }

      const memories = memoriesRepo.searchMemories(
        q as string,
        group_id as string | undefined,
        type as MemoryType | undefined,
        limit ? parseInt(limit as string, 10) : 20
      );

      res.json({ memories });
    } catch (error) {
      log.error('[MemoriesAPI] Error searching memories:', error);
      res.status(500).json({ error: 'Failed to search memories' });
    }
  });

  /**
   * POST /memories
   * Create a new memory
   */
  router.post('/', (req: Request, res: Response) => {
    try {
      const { content, type, group_id, session_id, tags } = req.body;

      if (!content || !type || !group_id) {
        res.status(400).json({ error: 'content, type, and group_id are required' });
        return;
      }

      // Validate type
      const validTypes: MemoryType[] = ['decision', 'error_fix', 'pattern', 'context', 'note'];
      if (!validTypes.includes(type)) {
        res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
        return;
      }

      const memory = memoriesRepo.createMemory({
        id: crypto.randomUUID(),
        groupId: group_id,
        sessionId: session_id || undefined,
        type,
        content,
        source: 'claude', // Memories from MCP are Claude-created
        tags: tags || [],
        pinned: false,
      });

      res.status(201).json({ memory });
    } catch (error) {
      log.error('[MemoriesAPI] Error creating memory:', error);
      res.status(500).json({ error: 'Failed to create memory' });
    }
  });

  /**
   * DELETE /memories/:id
   * Delete a memory
   */
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);

      const success = memoriesRepo.deleteMemory(id);

      if (success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Memory not found' });
      }
    } catch (error) {
      log.error('[MemoriesAPI] Error deleting memory:', error);
      res.status(500).json({ error: 'Failed to delete memory' });
    }
  });

  /**
   * PATCH /memories/:id/pin
   * Pin or unpin a memory
   */
  router.patch('/:id/pin', (req: Request, res: Response) => {
    try {
      const id = getStringParam(req.params.id);
      const { pinned } = req.body;

      if (typeof pinned !== 'boolean') {
        res.status(400).json({ error: 'pinned must be a boolean' });
        return;
      }

      const success = memoriesRepo.updateMemory(id, { pinned });

      if (success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Memory not found' });
      }
    } catch (error) {
      log.error('[MemoriesAPI] Error updating memory:', error);
      res.status(500).json({ error: 'Failed to update memory' });
    }
  });

  /**
   * GET /memories/groups
   * List available groups (convenience endpoint for MCP)
   */
  router.get('/groups', (_req: Request, res: Response) => {
    try {
      const groups = groupsRepo.getAllGroups();
      res.json({ groups: groups.map(g => ({ id: g.id, name: g.name })) });
    } catch (error) {
      log.error('[MemoriesAPI] Error listing groups:', error);
      res.status(500).json({ error: 'Failed to list groups' });
    }
  });

  return router;
}
