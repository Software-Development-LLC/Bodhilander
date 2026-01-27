/**
 * Code Search API Routes
 *
 * Provides REST endpoints for semantic code search and symbol lookup.
 * Used by the MCP server to access code search without native module dependencies.
 */

import { Router, Request, Response } from 'express';
import { getVectorSearchManager } from '../../vector-search';
import { SymbolType } from '../../../shared/types';
import log from 'electron-log';

/**
 * Middleware to restrict to localhost only (for MCP server)
 */
function localhostOnly(req: Request, res: Response, next: () => void): void {
  const ip = req.socket.remoteAddress || '';
  const clientIp = ip.replace(/^::ffff:/, '');

  if (clientIp !== '127.0.0.1' && clientIp !== '::1' && clientIp !== 'localhost') {
    log.warn(`[CodeSearchAPI] Rejected non-localhost request from: ${clientIp}`);
    res.status(403).json({ error: 'Access denied: localhost only' });
    return;
  }

  next();
}

export function createCodeSearchRouter(): Router {
  const router = Router();

  // Apply localhost-only restriction to all code search routes
  router.use(localhostOnly);

  /**
   * GET /code/search
   * Semantic code search
   */
  router.get('/search', async (req: Request, res: Response) => {
    try {
      const { q, path, limit } = req.query;

      if (!q || typeof q !== 'string') {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
      }

      const searchPath = (path as string) || process.cwd();
      const searchLimit = limit ? parseInt(limit as string, 10) : 10;

      const manager = getVectorSearchManager();
      const results = await manager.searchCode(searchPath, q, searchLimit);

      res.json({ results });
    } catch (error) {
      log.error('[CodeSearchAPI] Error searching code:', error);
      res.status(500).json({ error: 'Failed to search code' });
    }
  });

  /**
   * GET /code/symbols
   * Symbol search
   */
  router.get('/symbols', (req: Request, res: Response) => {
    try {
      const { name, path, type, limit } = req.query;

      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Query parameter "name" is required' });
        return;
      }

      const searchPath = (path as string) || process.cwd();
      const searchLimit = limit ? parseInt(limit as string, 10) : 20;
      const symbolType = type as SymbolType | undefined;

      const manager = getVectorSearchManager();
      const results = manager.searchSymbols(searchPath, name, symbolType, searchLimit);

      res.json({ results });
    } catch (error) {
      log.error('[CodeSearchAPI] Error searching symbols:', error);
      res.status(500).json({ error: 'Failed to search symbols' });
    }
  });

  /**
   * GET /code/index/status
   * Get index status for a directory
   */
  router.get('/index/status', (req: Request, res: Response) => {
    try {
      const { path } = req.query;

      if (!path || typeof path !== 'string') {
        res.status(400).json({ error: 'Query parameter "path" is required' });
        return;
      }

      const manager = getVectorSearchManager();
      const index = manager.getIndexStatus(path);

      res.json({ index });
    } catch (error) {
      log.error('[CodeSearchAPI] Error getting index status:', error);
      res.status(500).json({ error: 'Failed to get index status' });
    }
  });

  /**
   * GET /code/indexes
   * List all indexes
   */
  router.get('/indexes', (_req: Request, res: Response) => {
    try {
      const manager = getVectorSearchManager();
      const indexes = manager.getAllIndexes();

      res.json({ indexes });
    } catch (error) {
      log.error('[CodeSearchAPI] Error listing indexes:', error);
      res.status(500).json({ error: 'Failed to list indexes' });
    }
  });

  /**
   * POST /code/index
   * Start indexing a directory
   */
  router.post('/index', async (req: Request, res: Response) => {
    try {
      const { path } = req.body;

      if (!path || typeof path !== 'string') {
        res.status(400).json({ error: 'Body parameter "path" is required' });
        return;
      }

      const manager = getVectorSearchManager();
      await manager.startIndexing(path);

      res.json({ success: true });
    } catch (error) {
      log.error('[CodeSearchAPI] Error starting indexing:', error);
      res.status(500).json({ error: 'Failed to start indexing' });
    }
  });

  /**
   * DELETE /code/index
   * Delete index for a directory
   */
  router.delete('/index', (req: Request, res: Response) => {
    try {
      const { path } = req.query;

      if (!path || typeof path !== 'string') {
        res.status(400).json({ error: 'Query parameter "path" is required' });
        return;
      }

      const manager = getVectorSearchManager();
      manager.deleteIndex(path);

      res.json({ success: true });
    } catch (error) {
      log.error('[CodeSearchAPI] Error deleting index:', error);
      res.status(500).json({ error: 'Failed to delete index' });
    }
  });

  return router;
}
