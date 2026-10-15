import type { Request } from 'express';

export function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

/**
 * Extract client IP from request
 */
export function getClientIp(req: Request): string {
  // Don't trust X-Forwarded-For - we're not behind a proxy
  const ip = req.socket.remoteAddress || '';
  // Handle IPv4-mapped IPv6 addresses
  return ip.replace(/^::ffff:/, '');
}
