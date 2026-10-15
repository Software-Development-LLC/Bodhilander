/**
 * What the Claude Desktop device may do, enforced here rather than trusted to
 * the extension: loopback only, the routes the extension uses, and terminal
 * access only to sessions this device started.
 */
import { CLAUDE_DESKTOP_PLATFORM } from '../../shared/claude-desktop';
import { isLoopbackIp } from './client-ip';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

interface Allowed {
  method: string;
  path: RegExp;
  /** Whether the session id in the first capture must be one this device created. */
  ownSession?: boolean;
}

const ALLOWED: Allowed[] = [
  { method: 'GET', path: /^\/api\/v1\/sessions\/?$/ },
  { method: 'GET', path: /^\/api\/v1\/groups\/?$/ },
  { method: 'GET', path: new RegExp(`^/api/v1/sessions/${UUID}/?$`) },
  { method: 'GET', path: new RegExp(`^/api/v1/sessions/${UUID}/chat-events/?$`) },
  { method: 'GET', path: /^\/api\/v1\/runs\/[^/]+\/status\/?$/ },
  { method: 'POST', path: /^\/api\/v1\/sessions\/?$/ },
  { method: 'GET', path: new RegExp(`^/api/v1/terminal/(${UUID})/buffer/?$`), ownSession: true },
  { method: 'POST', path: new RegExp(`^/api/v1/terminal/(${UUID})/input/?$`), ownSession: true },
];

const ownedSessions = new Set<string>();

export function isClaudeDesktopDevice(device: { platform: string } | undefined): boolean {
  return device?.platform === CLAUDE_DESKTOP_PLATFORM;
}

export function recordClaudeDesktopSession(sessionId: string): void {
  ownedSessions.add(sessionId.toLowerCase());
}

export function forgetClaudeDesktopSessions(): void {
  ownedSessions.clear();
}

/** Why this request is refused, or null when the Claude Desktop device may make it. */
export function claudeDesktopRefusal(method: string, clientIp: string, url: string): string | null {
  if (!isLoopbackIp(clientIp)) return 'Claude Desktop access is only accepted from this computer';
  const urlPath = url.split('?')[0];
  for (const rule of ALLOWED) {
    if (rule.method !== method) continue;
    const match = rule.path.exec(urlPath);
    if (!match) continue;
    if (rule.ownSession && !ownedSessions.has(match[1].toLowerCase())) {
      return 'Claude Desktop can only use the terminal of sessions it started';
    }
    return null;
  }
  return 'Claude Desktop access does not include this action';
}
