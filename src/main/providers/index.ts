import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ProviderDefinition } from './types';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import { geminiProvider } from './gemini';
import { grokProvider } from './grok';

export * from './types';
export { claudeProvider, CLAUDE_CONFIG_DIR_ENV } from './claude';

export const DEFAULT_PROVIDER_ID = claudeProvider.id;

const REGISTRY: ReadonlyMap<string, ProviderDefinition> = new Map(
  [claudeProvider, codexProvider, geminiProvider, grokProvider].map((p) => [p.id, p])
);

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
