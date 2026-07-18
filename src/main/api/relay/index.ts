import { RelayClient } from './relay-client';

export { RelayClient } from './relay-client';
export type { RelayStatus } from './relay-client';

let instance: RelayClient | null = null;

/** Lazily constructed singleton relay client (see getApiServer for the pattern). */
export function getRelayClient(): RelayClient {
  instance ??= new RelayClient();
  return instance;
}
