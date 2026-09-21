/**
 * Making a gate survive a flaky or spent API (CO-722 R1).
 *
 * A single gate is a `claude` process, and one that hits an API error reaches no
 * conclusion -- `gate-process` reports it `undriveable` with `apiError: true`.
 * Left there, one hiccup anywhere in a ~30-minute multi-gate run parks the whole
 * run. This wraps a gate run with the one distinction that matters:
 *
 *   - a **usage cap** (the account is out of weekly/5-hour quota) must NOT be
 *     retried -- retrying only burns launches into the same 429 -- so it holds,
 *     with a clear reason and the account marked limited so resolution steps
 *     aside next time;
 *   - a **transient** API error (a 5xx/overload) is worth a bounded, backed-off
 *     retry before giving up.
 *
 * The cap is told from the transient by the CLI's OWN structured quota entry
 * (`quota-limit.readQuotaLimit`), never by matching prose -- so we never retry a
 * cap by mistake, which is the failure this must not have.
 *
 * The two DB-touching operations (mark an account limited, map a config dir back
 * to its account) are injected, so this module -- and its test -- stay clear of
 * `better-sqlite3`; the wiring passes the real repository functions.
 */
import log from 'electron-log';
import type { GateOutcome } from './gate-process';
import { readQuotaLimit, describeRateLimitType, type QuotaLimitHit } from '../quota-limit';

export interface GateResilienceDeps {
  /** Run the gate once. Called again for each bounded retry. */
  run: () => Promise<GateOutcome>;
  /** The managed account's config dir the gate ran under; null = ambient login. */
  configDir: string | null;
  /** The gate's conversation id, used to find its transcript for a quota entry. */
  sessionId: string;
  /** When this gate started -- a quota entry older than this is a stale replay. */
  startedAt: Date;
  /** Mark an account rate-limited until `until` (injected: repository write). */
  markLimited: (accountId: string, until: Date) => void;
  /** The account id owning `configDir`, or null (injected: repository read). */
  accountIdForDir: (configDir: string) => string | null;

  // Everything below is injected only by tests; production uses the defaults.
  /** Read the CLI's structured quota rejection, if any. */
  readQuota?: (configDir: string, conversationId: string, since: Date, now: Date) => QuotaLimitHit | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Retries AFTER the first attempt (default 2 -> 3 tries total). */
  retries?: number;
  /** Backoff before retry N (1-based). Default 30s, 60s. */
  delayMs?: (attempt: number) => number;
  log?: (line: string) => void;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_DELAY = (attempt: number): number => 30_000 * 2 ** (attempt - 1);

/**
 * Run a gate, retrying a transient API error and holding on a usage cap.
 *
 * Only an `undriveable` outcome flagged `apiError` is ever acted on; a
 * completed gate, a launched `--bg` gate, a timeout or a cancellation pass
 * straight through untouched.
 */
export async function runGateResilient(deps: GateResilienceDeps): Promise<GateOutcome> {
  const retries = deps.retries ?? DEFAULT_RETRIES;
  const delayMs = deps.delayMs ?? DEFAULT_DELAY;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  const readQuota = deps.readQuota ?? readQuotaLimit;
  const say = deps.log ?? ((line) => log.info(`[GateResilience] ${line}`));

  // At most `retries` retries after the first attempt, so the loop is bounded.
  let outcome = await deps.run();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (outcome.status !== 'undriveable' || outcome.apiError !== true) return outcome;

    // A usage cap is the CLI's own structured assertion, not a guess. When it is
    // present, holding is correct and retrying is harmful, so mark the account
    // limited (resolution steps aside next time) and stop with a clear reason.
    const quota = deps.configDir ? readQuota(deps.configDir, deps.sessionId, deps.startedAt, now()) : null;
    if (quota) {
      const window = describeRateLimitType(quota.rateLimitType);
      const accountId = deps.configDir ? deps.accountIdForDir(deps.configDir) : null;
      if (accountId) deps.markLimited(accountId, quota.resetAt);
      say(`gate hit an account ${window}; holding until ${quota.resetAt.toISOString()} (no retry)`);
      return { ...outcome, reason: `the account hit its ${window}, resets ${quota.resetAt.toISOString()}` };
    }

    // Not a cap: a transient API error. Retry, bounded and backed off.
    if (attempt === retries) break;
    const wait = delayMs(attempt + 1);
    say(`gate hit a transient API error; retry ${attempt + 1}/${retries} in ${wait}ms`);
    await sleep(wait);
    outcome = await deps.run();
  }
  return outcome;
}
