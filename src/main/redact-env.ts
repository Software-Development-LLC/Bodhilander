/**
 * Redact secret-bearing entries from an environment map before it goes
 * anywhere observable (logs, diagnostics). The pattern covers generic
 * credential naming — including every provider API-key env var the vault
 * can inject (#99): ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
 * XAI_API_KEY all match /key/i.
 *
 * (Lives outside pty-manager so it stays importable without node-pty.)
 */
export function redactEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k,
      /key|secret|token|password|auth/i.test(k) ? '[REDACTED]' : v,
    ])
  );
}
