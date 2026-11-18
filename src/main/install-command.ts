import type { ShellInfo } from './shell-detector';
import type { ProviderDefinition } from './providers/types';

export interface ResolvedInstall {
  installHint: string;
  installCommand: string | null;
  /** Run under PowerShell rather than the user's shell. */
  powershell: boolean;
}

/**
 * The install hint and command a provider shows and runs under the given
 * shell. The only place the platform variant is chosen, so Settings, the
 * launch-failure banner and the install pty agree. Never touches the disk.
 */
export function resolveInstall(
  setup: ProviderDefinition['setup'],
  shellInfo: Pick<ShellInfo, 'isWSL'>,
): ResolvedInstall {
  const native = process.platform === 'win32' && !shellInfo.isWSL;
  const variant = native && setup.windows ? setup.windows : null;
  if (variant) {
    return {
      installHint: variant.installHint,
      installCommand: variant.installCommand ?? null,
      powershell: variant.powershell === true,
    };
  }
  return {
    installHint: setup.installHint,
    installCommand: setup.installCommand ?? null,
    powershell: false,
  };
}
