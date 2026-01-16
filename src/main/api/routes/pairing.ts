/**
 * Pairing API Routes
 *
 * Device pairing endpoints for mobile companion apps.
 */

import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { networkInterfaces, hostname } from 'os';
import log from 'electron-log';
import { PairingManager } from '../pairing/pairing-manager';
import { validatePairingConfirm } from '../middleware/validation';
import { authenticateDevice } from '../middleware/auth';

export function createPairingRouter(pairingManager: PairingManager): Router {
  const router = Router();

  /**
   * POST /pairing/initiate - Generate a new pairing code
   *
   * This is called from the desktop app to start the pairing process.
   * Returns a pairing code and QR code data.
   */
  router.post('/initiate', async (req: Request, res: Response) => {
    try {
      const { canControl = true, canModify = false } = req.body;

      // Generate pairing code
      const pairingInfo = pairingManager.generatePairingCode({
        canControl,
        canModify,
      });

      // Get local IP addresses
      const addresses = getLocalAddresses();
      const primaryAddress = addresses[0] || '127.0.0.1';

      // Get port from request (will be set by the server)
      const port = (req.socket.localPort || 8443).toString();

      // Build QR code data
      const qrData = {
        type: 'claudelander-pair',
        host: primaryAddress,
        port: parseInt(port),
        code: pairingInfo.code,
        hostname: hostname(),
        expiresAt: pairingInfo.expiresAt,
      };

      // Generate QR code as data URL
      const qrCodeDataUrl = await QRCode.toDataURL(JSON.stringify(qrData), {
        errorCorrectionLevel: 'M',
        width: 256,
        margin: 2,
      });

      res.json({
        code: pairingInfo.code,
        qrCode: qrCodeDataUrl,
        expiresAt: pairingInfo.expiresAt,
        addresses,
        port: parseInt(port),
        hostname: hostname(),
      });

      log.info('[PairingAPI] Pairing initiated');
    } catch (error) {
      log.error('[PairingAPI] Error initiating pairing:', error);
      res.status(500).json({ error: 'Failed to initiate pairing' });
    }
  });

  /**
   * POST /pairing/confirm - Confirm pairing with code
   *
   * Called from the mobile app with the pairing code.
   * Returns an authentication token if successful.
   */
  router.post('/confirm', validatePairingConfirm, (req: Request, res: Response) => {
    try {
      const { code, deviceName, platform } = req.body;

      const result = pairingManager.completePairing(code, deviceName, platform);

      if (!result) {
        res.status(400).json({ error: 'Invalid or expired pairing code' });
        return;
      }

      res.json({
        token: result.token,
        device: {
          id: result.device.id,
          name: result.device.name,
          canControl: result.device.canControl,
          canModify: result.device.canModify,
        },
      });

      log.info(`[PairingAPI] Device paired: ${deviceName} (${platform})`);
    } catch (error) {
      log.error('[PairingAPI] Error confirming pairing:', error);
      res.status(500).json({ error: 'Failed to confirm pairing' });
    }
  });

  /**
   * GET /pairing/status - Check if there's an active pairing code
   */
  router.get('/status', (_req: Request, res: Response) => {
    try {
      res.json({
        active: pairingManager.hasActivePairingCode(),
      });
    } catch (error) {
      log.error('[PairingAPI] Error getting pairing status:', error);
      res.status(500).json({ error: 'Failed to get pairing status' });
    }
  });

  /**
   * POST /pairing/cancel - Cancel the current pairing code
   */
  router.post('/cancel', (_req: Request, res: Response) => {
    try {
      pairingManager.cancelPairing();
      res.json({ success: true });
    } catch (error) {
      log.error('[PairingAPI] Error cancelling pairing:', error);
      res.status(500).json({ error: 'Failed to cancel pairing' });
    }
  });

  /**
   * GET /pairing/devices - List all paired devices (requires auth)
   */
  router.get('/devices', authenticateDevice(pairingManager), (_req: Request, res: Response) => {
    try {
      const devices = pairingManager.getAllDevices();
      res.json({
        devices: devices.map(d => ({
          id: d.id,
          name: d.name,
          platform: d.platform,
          canControl: d.canControl,
          canModify: d.canModify,
          createdAt: d.createdAt.toISOString(),
          lastUsedAt: d.lastUsedAt.toISOString(),
        })),
      });
    } catch (error) {
      log.error('[PairingAPI] Error listing devices:', error);
      res.status(500).json({ error: 'Failed to list devices' });
    }
  });

  /**
   * DELETE /pairing/devices/:id - Unpair a device (requires auth)
   */
  router.delete('/devices/:id', authenticateDevice(pairingManager), (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Don't allow device to unpair itself
      if (req.device?.id === id) {
        res.status(400).json({ error: 'Cannot unpair the current device' });
        return;
      }

      const success = pairingManager.unpairDevice(id);

      if (!success) {
        res.status(404).json({ error: 'Device not found' });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      log.error('[PairingAPI] Error unpairing device:', error);
      res.status(500).json({ error: 'Failed to unpair device' });
    }
  });

  return router;
}

function getLocalAddresses(): string[] {
  const addresses: string[] = [];
  const interfaces = networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;

    for (const net of nets) {
      // Skip internal (loopback) addresses
      if (net.internal) continue;

      // Only include IPv4 addresses
      if (net.family === 'IPv4') {
        addresses.push(net.address);
      }
    }
  }

  // Prioritize 192.168.x.x (typical LAN) over 172.x.x (often Docker/WSL/Hyper-V) and 10.x.x
  return addresses.sort((a, b) => {
    const score = (ip: string) => {
      if (ip.startsWith('192.168.')) return 0;
      if (ip.startsWith('10.')) return 1;
      if (ip.startsWith('172.')) return 2;
      return 3;
    };
    return score(a) - score(b);
  });
}
