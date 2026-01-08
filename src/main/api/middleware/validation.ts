/**
 * Request Validation Middleware
 *
 * Provides validation functions for API request inputs.
 * Reuses validation logic from main validation module where possible.
 */

import { Request, Response, NextFunction } from 'express';
import {
  isValidUUID,
  isNonEmptyString,
  isValidFilePath,
  isValidSessionState,
  isValidColor,
  isNonNegativeInteger,
} from '../../validation';

/**
 * Validation error response helper
 */
function validationError(res: Response, field: string, message: string): void {
  res.status(400).json({
    error: 'Validation error',
    field,
    message,
  });
}

/**
 * Validate session creation request body
 */
export function validateCreateSession(req: Request, res: Response, next: NextFunction): void {
  const { groupId, name, workingDir } = req.body;

  if (!isValidUUID(groupId)) {
    validationError(res, 'groupId', 'Invalid group ID format');
    return;
  }

  if (!isNonEmptyString(name, 255)) {
    validationError(res, 'name', 'Name is required and must be less than 255 characters');
    return;
  }

  if (workingDir !== undefined && !isValidFilePath(workingDir)) {
    validationError(res, 'workingDir', 'Invalid working directory path');
    return;
  }

  next();
}

/**
 * Validate session update request body
 */
export function validateUpdateSession(req: Request, res: Response, next: NextFunction): void {
  const { name, groupId, state, order } = req.body;

  if (name !== undefined && !isNonEmptyString(name, 255)) {
    validationError(res, 'name', 'Name must be a non-empty string less than 255 characters');
    return;
  }

  if (groupId !== undefined && !isValidUUID(groupId)) {
    validationError(res, 'groupId', 'Invalid group ID format');
    return;
  }

  if (state !== undefined && !isValidSessionState(state)) {
    validationError(res, 'state', 'Invalid session state');
    return;
  }

  if (order !== undefined && !isNonNegativeInteger(order)) {
    validationError(res, 'order', 'Order must be a non-negative integer');
    return;
  }

  next();
}

/**
 * Validate group creation request body
 */
export function validateCreateGroup(req: Request, res: Response, next: NextFunction): void {
  const { name, color, workingDir, parentId } = req.body;

  if (!isNonEmptyString(name, 255)) {
    validationError(res, 'name', 'Name is required and must be less than 255 characters');
    return;
  }

  if (color !== undefined && !isValidColor(color)) {
    validationError(res, 'color', 'Invalid color format (expected #RRGGBB)');
    return;
  }

  if (workingDir !== undefined && workingDir !== '' && !isValidFilePath(workingDir)) {
    validationError(res, 'workingDir', 'Invalid working directory path');
    return;
  }

  if (parentId !== undefined && parentId !== null && !isValidUUID(parentId)) {
    validationError(res, 'parentId', 'Invalid parent ID format');
    return;
  }

  next();
}

/**
 * Validate group update request body
 */
export function validateUpdateGroup(req: Request, res: Response, next: NextFunction): void {
  const { name, color, workingDir, parentId, order, collapsed } = req.body;

  if (name !== undefined && !isNonEmptyString(name, 255)) {
    validationError(res, 'name', 'Name must be a non-empty string less than 255 characters');
    return;
  }

  if (color !== undefined && !isValidColor(color)) {
    validationError(res, 'color', 'Invalid color format (expected #RRGGBB)');
    return;
  }

  if (workingDir !== undefined && workingDir !== '' && !isValidFilePath(workingDir)) {
    validationError(res, 'workingDir', 'Invalid working directory path');
    return;
  }

  if (parentId !== undefined && parentId !== null && !isValidUUID(parentId)) {
    validationError(res, 'parentId', 'Invalid parent ID format');
    return;
  }

  if (order !== undefined && !isNonNegativeInteger(order)) {
    validationError(res, 'order', 'Order must be a non-negative integer');
    return;
  }

  if (collapsed !== undefined && typeof collapsed !== 'boolean') {
    validationError(res, 'collapsed', 'Collapsed must be a boolean');
    return;
  }

  next();
}

/**
 * Validate ID parameter
 */
export function validateIdParam(req: Request, res: Response, next: NextFunction): void {
  const { id } = req.params;

  if (!isValidUUID(id)) {
    validationError(res, 'id', 'Invalid ID format');
    return;
  }

  next();
}

/**
 * Validate pairing confirmation request
 */
export function validatePairingConfirm(req: Request, res: Response, next: NextFunction): void {
  const { code, deviceName, platform } = req.body;

  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    validationError(res, 'code', 'Invalid pairing code format (expected 6 digits)');
    return;
  }

  if (!isNonEmptyString(deviceName, 100)) {
    validationError(res, 'deviceName', 'Device name is required and must be less than 100 characters');
    return;
  }

  if (!isNonEmptyString(platform, 50)) {
    validationError(res, 'platform', 'Platform is required (e.g., "ios", "android")');
    return;
  }

  next();
}
