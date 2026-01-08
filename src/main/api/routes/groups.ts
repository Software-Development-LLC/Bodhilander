/**
 * Groups API Routes
 *
 * CRUD operations for groups.
 */

import { Router, Request, Response } from 'express';
import log from 'electron-log';
import * as groupsRepo from '../../repositories/groups';
import { requireModifyPermission } from '../middleware/auth';
import {
  validateIdParam,
  validateCreateGroup,
  validateUpdateGroup,
} from '../middleware/validation';
import { Group } from '../../../shared/types';

// Default colors for new groups
const DEFAULT_COLORS = [
  '#3b82f6', // Blue
  '#22c55e', // Green
  '#f59e0b', // Amber
  '#ef4444', // Red
  '#8b5cf6', // Purple
  '#06b6d4', // Cyan
  '#ec4899', // Pink
  '#f97316', // Orange
];

export function createGroupsRouter(): Router {
  const router = Router();

  /**
   * GET /groups - List all groups
   */
  router.get('/', (_req: Request, res: Response) => {
    try {
      const groups = groupsRepo.getAllGroups();
      res.json({ groups });
    } catch (error) {
      log.error('[GroupsAPI] Error listing groups:', error);
      res.status(500).json({ error: 'Failed to list groups' });
    }
  });

  /**
   * GET /groups/:id - Get a specific group
   */
  router.get('/:id', validateIdParam, (req: Request, res: Response) => {
    try {
      const groups = groupsRepo.getAllGroups();
      const group = groups.find(g => g.id === req.params.id);

      if (!group) {
        res.status(404).json({ error: 'Group not found' });
        return;
      }

      res.json({ group });
    } catch (error) {
      log.error('[GroupsAPI] Error getting group:', error);
      res.status(500).json({ error: 'Failed to get group' });
    }
  });

  /**
   * POST /groups - Create a new group
   */
  router.post(
    '/',
    requireModifyPermission,
    validateCreateGroup,
    (req: Request, res: Response) => {
      try {
        const { name, color, workingDir, parentId } = req.body;

        const groups = groupsRepo.getAllGroups();

        // Generate UUID for new group
        const id = generateUUID();
        const now = new Date();

        const group: Group = {
          id,
          name,
          color: color || DEFAULT_COLORS[groups.length % DEFAULT_COLORS.length],
          workingDir: workingDir || '',
          order: getNextOrder(groups, parentId || null),
          createdAt: now,
          parentId: parentId || null,
          collapsed: false,
        };

        groupsRepo.createGroup(group);

        log.info(`[GroupsAPI] Created group: ${id}`);
        res.status(201).json({ group });
      } catch (error) {
        log.error('[GroupsAPI] Error creating group:', error);
        res.status(500).json({ error: 'Failed to create group' });
      }
    }
  );

  /**
   * PATCH /groups/:id - Update a group
   */
  router.patch(
    '/:id',
    requireModifyPermission,
    validateIdParam,
    validateUpdateGroup,
    (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const updates = req.body;

        // Check group exists
        const groups = groupsRepo.getAllGroups();
        const group = groups.find(g => g.id === id);

        if (!group) {
          res.status(404).json({ error: 'Group not found' });
          return;
        }

        // Prevent circular parent references
        if (updates.parentId !== undefined) {
          if (updates.parentId === id) {
            res.status(400).json({ error: 'Group cannot be its own parent' });
            return;
          }

          // Check for circular reference
          if (updates.parentId && wouldCreateCircle(groups, id, updates.parentId)) {
            res.status(400).json({ error: 'Cannot create circular group hierarchy' });
            return;
          }
        }

        groupsRepo.updateGroup(id, updates);

        log.info(`[GroupsAPI] Updated group: ${id}`);
        res.json({ success: true });
      } catch (error) {
        log.error('[GroupsAPI] Error updating group:', error);
        res.status(500).json({ error: 'Failed to update group' });
      }
    }
  );

  /**
   * DELETE /groups/:id - Delete a group
   */
  router.delete(
    '/:id',
    requireModifyPermission,
    validateIdParam,
    (req: Request, res: Response) => {
      try {
        const { id } = req.params;

        // Note: Sessions in this group will be orphaned or cascade deleted
        // depending on database constraints
        groupsRepo.deleteGroup(id);

        log.info(`[GroupsAPI] Deleted group: ${id}`);
        res.json({ success: true });
      } catch (error) {
        log.error('[GroupsAPI] Error deleting group:', error);
        res.status(500).json({ error: 'Failed to delete group' });
      }
    }
  );

  /**
   * POST /groups/:id/toggle-collapse - Toggle group collapsed state
   */
  router.post(
    '/:id/toggle-collapse',
    validateIdParam,
    (req: Request, res: Response) => {
      try {
        const { id } = req.params;

        const groups = groupsRepo.getAllGroups();
        const group = groups.find(g => g.id === id);

        if (!group) {
          res.status(404).json({ error: 'Group not found' });
          return;
        }

        groupsRepo.updateGroup(id, { collapsed: !group.collapsed });

        res.json({ collapsed: !group.collapsed });
      } catch (error) {
        log.error('[GroupsAPI] Error toggling group collapse:', error);
        res.status(500).json({ error: 'Failed to toggle group collapse' });
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

function getNextOrder(groups: Group[], parentId: string | null): number {
  const siblings = groups.filter(g => g.parentId === parentId);
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map(g => g.order)) + 1;
}

function wouldCreateCircle(groups: Group[], groupId: string, newParentId: string): boolean {
  let currentId: string | null = newParentId;

  while (currentId) {
    if (currentId === groupId) {
      return true;
    }
    const parent = groups.find(g => g.id === currentId);
    currentId = parent?.parentId || null;
  }

  return false;
}
