import type { RelayConfig } from './config';

/**
 * Headroom over the handoff cap for request lines and headers, so a body at
 * exactly the cap still arrives whole.
 */
export const REQUEST_HEADER_SLACK_BYTES = 64 * 1024;

/**
 * What Bun will accept as a request body. Derived from the handoff cap rather
 * than set beside it: a wire ceiling below the cap kills every upload at the
 * socket, with an empty 413 that names no reason.
 */
export function requestBodyCeiling(config: RelayConfig): number {
  return config.handoffMaxBytes + REQUEST_HEADER_SLACK_BYTES;
}

/**
 * The most any other route may send. They all read small JSON, and the ceiling
 * above is far too generous for them now that a handoff sets it.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;
