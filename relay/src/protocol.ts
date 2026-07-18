/**
 * Wire-format constants shared between the relay and the desktop agent (Slice
 * B). Kept in one place so both sides build/verify the exact same bytes.
 */

/** Canonical message an agent signs (Ed25519) to register a machine via /link. */
export const LINK_MESSAGE_VERSION = 'link:v1';

export interface LinkMessageParts {
  ed25519PubB64: string;
  x25519PubB64: string;
  machineName: string;
  issuedAt: number;
}

export function buildLinkMessage(p: LinkMessageParts): Uint8Array {
  const line = [LINK_MESSAGE_VERSION, p.ed25519PubB64, p.x25519PubB64, p.machineName, String(p.issuedAt)].join('\n');
  return new TextEncoder().encode(line);
}

/** How far `issuedAt` may drift from server time before /link is rejected. */
export const LINK_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Canonical message an agent signs (Ed25519) to answer the relay's WebSocket
 * auth challenge. Namespaced so a signature can't be replayed across the /link
 * flow or any other protocol.
 */
export const AGENT_AUTH_VERSION = 'agent-auth:v1';

export function buildAgentAuthMessage(nonce: string): Uint8Array {
  return new TextEncoder().encode(`${AGENT_AUTH_VERSION}\n${nonce}`);
}
