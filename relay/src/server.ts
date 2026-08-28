import type { Server, WebSocketHandler } from 'bun';
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

export interface ServeInput<T> {
  config: RelayConfig;
  fetch: (req: Request, server: Server<T>) => Response | undefined | Promise<Response | undefined>;
  websocket: WebSocketHandler<T>;
}

/**
 * Everything `Bun.serve` is given. Shared with the entry point rather than
 * replicated in a test, so what a test starts is what production starts —
 * a copy pins its own copy and lets the deployed ceiling regress unseen.
 */
export function serveOptions<T>(input: ServeInput<T>) {
  return {
    port: input.config.port,
    maxRequestBodySize: requestBodyCeiling(input.config),
    fetch: input.fetch,
    websocket: input.websocket,
  };
}
