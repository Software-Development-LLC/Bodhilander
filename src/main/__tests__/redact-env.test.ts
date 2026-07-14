/**
 * redactEnv tests (#99): every provider API-key env var the vault can inject
 * must be scrubbed before an env map is ever logged.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { redactEnv } from '../redact-env';

describe('redactEnv', () => {
  test('scrubs every vault-injectable provider key env var', () => {
    const redacted = redactEnv({
      ANTHROPIC_API_KEY: 'sk-ant-live',
      OPENAI_API_KEY: 'sk-live',
      GEMINI_API_KEY: 'g-live',
      XAI_API_KEY: 'xai-live',
      PATH: '/usr/bin',
    })!;
    expect(redacted.ANTHROPIC_API_KEY).toBe('[REDACTED]');
    expect(redacted.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(redacted.GEMINI_API_KEY).toBe('[REDACTED]');
    expect(redacted.XAI_API_KEY).toBe('[REDACTED]');
    expect(redacted.PATH).toBe('/usr/bin');
  });

  test('scrubs generic credential naming and passes undefined through', () => {
    const redacted = redactEnv({ MY_SECRET: 'x', AUTH_TOKEN: 'y', DB_PASSWORD: 'z' })!;
    expect(Object.values(redacted).every(v => v === '[REDACTED]')).toBe(true);
    expect(redactEnv(undefined)).toBeUndefined();
  });
});
