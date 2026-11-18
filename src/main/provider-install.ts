/**
 * Provider install-command orchestration (follow-up to #97's install hints).
 *
 * Runs a provider's registry-defined install command in a visible pty the
 * renderer attaches a Terminal to. Kept out of index.ts so the IPC argument
 * validation — a trust boundary; the renderer only ever supplies ids — is
 * unit-testable without loading the whole main process.
 */

// Type-only: erased at compile time, so importing this module in tests does
// not drag in node-pty.
import type { PtyManager } from './pty-manager';
import { listProviders } from './providers';
import { resolveInstall } from './install-command';

/**
 * Namespace prefix for install ptys. cancelProviderInstall only kills ids
 * under it, so a malicious/buggy renderer call can't tear down a real
 * session's pty through the install-cancel channel.
 */
export const INSTALL_PTY_PREFIX = '__install-';

export const INSTALL_COMMAND_CHANGED = 'The install command changed since it was shown; confirm the current one';

export interface ProviderInstallStart {
  ptyId: string;
  command: string;
}

/**
 * Spawn the install pty for a provider. Commands come only from the static
 * provider registry — never from the renderer. Throws for unknown providers
 * and for providers without a runnable install command (e.g. GUI installs).
 * The renderer's confirmed command is only compared, never run: a shell
 * change since the dialog was built would otherwise run unconfirmed text.
 */
export async function startProviderInstall(
  ptyManager: PtyManager,
  providerId: unknown,
  confirmedCommand: unknown,
): Promise<ProviderInstallStart> {
  if (typeof providerId !== 'string' || providerId.length === 0) {
    throw new Error('Invalid providerId');
  }
  const provider = listProviders().find((p) => p.id === providerId);
  const install = provider ? resolveInstall(provider.setup, ptyManager.getDefaultShellInfo()) : null;
  const command = install?.installCommand;
  if (!install || !command) {
    throw new Error(`Provider '${providerId}' has no runnable install command`);
  }
  if (confirmedCommand !== command) {
    throw new Error(INSTALL_COMMAND_CHANGED);
  }
  const ptyId = `${INSTALL_PTY_PREFIX}${providerId}`;
  // A previous run's pty may still be around (user reopened the modal).
  await ptyManager.kill(ptyId);
  ptyManager.createInstallSession(ptyId, command, { powershell: install.powershell });
  return { ptyId, command };
}

/** Kill an install pty. Rejects ids outside the install namespace. */
export async function cancelProviderInstall(
  ptyManager: PtyManager,
  ptyId: unknown,
): Promise<void> {
  if (typeof ptyId !== 'string' || !ptyId.startsWith(INSTALL_PTY_PREFIX)) {
    throw new Error('Not an install pty');
  }
  await ptyManager.kill(ptyId);
}
