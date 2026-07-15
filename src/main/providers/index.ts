import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import log from 'electron-log';
import { DEFAULT_SESSION_PROVIDER } from '../../shared/types';
import { ProviderDefinition } from './types';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import { grokProvider } from './grok';

export * from './types';
export { claudeProvider, CLAUDE_CONFIG_DIR_ENV } from './claude';

/** Single source of truth for the default lives in shared/types so the renderer agrees. */
export const DEFAULT_PROVIDER_ID = DEFAULT_SESSION_PROVIDER;

// gemini was removed: Google retired the CLI's consumer OAuth login
// (June 2026), so out of the box it dead-ends at "client is no longer
// supported". Persisted 'gemini' sessions degrade via resolveProvider().
const REGISTRY: ReadonlyMap<string, ProviderDefinition> = new Map(
  [claudeProvider, codexProvider, grokProvider].map((p) => [p.id, p])
);

if (!REGISTRY.has(DEFAULT_PROVIDER_ID)) {
  throw new Error(`Default provider '${DEFAULT_PROVIDER_ID}' is not registered`);
}

export function isKnownProvider(id: string): boolean {
  return REGISTRY.has(id);
}

/**
 * Resolve a provider id to its definition, falling back to the default with
 * a logged warning when the id is unknown — e.g. a session row or import
 * written by a newer app version (#96). Every launch path goes through this
 * so an unrecognized id degrades to a Claude session instead of a failed
 * launch. Use getProvider() instead where an unknown id is a programming
 * error that should throw.
 */
export function resolveProvider(id: string | null | undefined, context?: string): ProviderDefinition {
  if (id && isKnownProvider(id)) {
    return REGISTRY.get(id)!;
  }
  if (id) {
    const where = context ? ` (${context})` : '';
    log.warn(`[Providers] Unknown provider '${id}'${where}; falling back to '${DEFAULT_PROVIDER_ID}'`);
  }
  return claudeProvider;
}

/**
 * Which provider id a session launch should use (#98). The persisted row is
 * authoritative once it exists (#96 invariant); the explicitly-passed id only
 * bridges the gap where the renderer mounted a terminal before the row was
 * persisted. Falls back to the default when neither is available.
 */
export function resolveLaunchProviderId(
  stored: string | null | undefined,
  explicit: string | null | undefined
): string {
  return stored ?? explicit ?? DEFAULT_PROVIDER_ID;
}

export function getProvider(id: string): ProviderDefinition {
  const provider = REGISTRY.get(id);
  if (!provider) {
    throw new Error(`Unknown session provider: ${id}`);
  }
  return provider;
}

export function listProviders(): ProviderDefinition[] {
  return Array.from(REGISTRY.values());
}

/**
 * Generate a new agent conversation UUID for first-launch use (BDHLNDR-9).
 * Format matches Claude CLI's `--session-id` requirement (standard v4 UUID).
 */
export function generateAgentSessionId(): string {
  return crypto.randomUUID();
}

/** Socket the hook script reports agent state changes over. */
export function getSocketPath(): string {
  if (process.platform === 'win32') {
    // Use Windows named pipes
    return `\\\\.\\pipe\\bodhilander-${process.pid}`;
  }
  // Use Unix domain sockets on macOS/Linux
  const tmpDir = os.tmpdir();
  return path.join(tmpDir, `bodhilander-${process.pid}.sock`);
}
