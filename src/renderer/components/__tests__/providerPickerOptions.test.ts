/**
 * Provider-picker option building tests (#98).
 *
 * Run with: bun test src/renderer/components/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { buildProviderOptions } from '../providerPickerOptions';
import { ProviderStatus, DEFAULT_SESSION_PROVIDER } from '../../../shared/types';

function status(overrides: Partial<ProviderStatus>): ProviderStatus {
  return {
    id: 'codex',
    name: 'Codex (OpenAI)',
    command: 'codex',
    installed: false,
    version: null,
    installHint: 'npm install -g @openai/codex',
    docsUrl: 'https://example.invalid',
    loginHint: 'codex login',
    ...overrides,
  };
}

describe('buildProviderOptions', () => {
  test('detection in flight renders a single enabled default option', () => {
    expect(buildProviderOptions(null)).toEqual([
      { id: DEFAULT_SESSION_PROVIDER, label: 'Claude Code (detecting others…)', disabled: false },
    ]);
  });

  test('detection failure ([]) still renders the default — never an empty select', () => {
    expect(buildProviderOptions([])).toEqual([
      { id: DEFAULT_SESSION_PROVIDER, label: 'Claude Code', disabled: false },
    ]);
  });

  test('installed providers are enabled with a plain label', () => {
    const opts = buildProviderOptions([status({ id: 'grok', name: 'Grok Build (xAI)', installed: true })]);
    expect(opts).toEqual([{ id: 'grok', label: 'Grok Build (xAI)', disabled: false }]);
  });

  test('missing non-default providers are disabled and marked not installed', () => {
    const opts = buildProviderOptions([status({ installed: false })]);
    expect(opts).toEqual([{ id: 'codex', label: 'Codex (OpenAI) — not installed', disabled: true }]);
  });

  test('the default provider stays selectable when undetected, marked inline', () => {
    const opts = buildProviderOptions([
      status({ id: DEFAULT_SESSION_PROVIDER, name: 'Claude Code', installed: false }),
    ]);
    expect(opts).toEqual([
      { id: DEFAULT_SESSION_PROVIDER, label: 'Claude Code — not detected', disabled: false },
    ]);
  });
});
