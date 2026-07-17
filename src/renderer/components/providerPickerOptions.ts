import { ProviderStatus, DEFAULT_SESSION_PROVIDER } from '../../shared/types';

export interface ProviderOption {
  id: string;
  label: string;
  disabled: boolean;
}

/**
 * Build the option list for the new-session provider picker (#98).
 *
 * - `null` statuses (detection in flight) → a single enabled default option.
 * - `[]` statuses (detection failed) → a single enabled default option, so
 *   the select never renders empty.
 * - Otherwise one option per provider: undetected providers are disabled,
 *   except the default, which stays selectable (labelled "not detected")
 *   so session creation never dead-ends.
 *
 * Pure — extracted from NamePromptModal for direct unit testing.
 */
export function buildProviderOptions(providers: ProviderStatus[] | null): ProviderOption[] {
  if (providers === null) {
    return [{ id: DEFAULT_SESSION_PROVIDER, label: 'Claude Code (detecting others…)', disabled: false }];
  }
  if (providers.length === 0) {
    return [{ id: DEFAULT_SESSION_PROVIDER, label: 'Claude Code', disabled: false }];
  }
  return providers.map((p) => {
    const isDefault = p.id === DEFAULT_SESSION_PROVIDER;
    let suffix = '';
    if (!p.installed) {
      suffix = isDefault ? ' — not detected' : ' — not installed';
    }
    return {
      id: p.id,
      label: `${p.name}${suffix}`,
      disabled: !p.installed && !isDefault,
    };
  });
}
