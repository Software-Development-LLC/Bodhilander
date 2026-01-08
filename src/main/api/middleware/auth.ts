/**
 * Authentication Middleware
 *
 * Validates device tokens for API requests from mobile companions.
 */

import { Request, Response, NextFunction } from 'express';
import log from 'electron-log';
import { PairingManager, PairedDevice } from '../pairing/pairing-manager';

// Extend Express Request to include device info
declare global {
  namespace Express {
    interface Request {
      device?: PairedDevice;
    }
  }
}

/**
 * Create authentication middleware
 */
export function authenticateDevice(pairingManager: PairingManager) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Authorization header required' });
      return;
    }

    // Expect: Bearer <token>
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      res.status(401).json({ error: 'Invalid authorization format. Expected: Bearer <token>' });
      return;
    }

    const token = parts[1];

    // Validate token and get device
    const device = pairingManager.validateToken(token);
    if (!device) {
      log.warn('[Auth] Invalid or expired token');
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Update last used timestamp
    pairingManager.updateLastUsed(device.id);

    // Attach device to request for use in routes
    req.device = device;

    next();
  };
}

/**
 * Middleware to check if device has control permission
 */
export function requireControlPermission(req: Request, res: Response, next: NextFunction): void {
  if (!req.device) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!req.device.canControl) {
    res.status(403).json({ error: 'Control permission required' });
    return;
  }

  next();
}

/**
 * Middleware to check if device has modify permission
 */
export function requireModifyPermission(req: Request, res: Response, next: NextFunction): void {
  if (!req.device) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!req.device.canModify) {
    res.status(403).json({ error: 'Modify permission required' });
    return;
  }

  next();
}
