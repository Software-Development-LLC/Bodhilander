/**
 * App's account-identity wiring (#165).
 *
 * Two pure resolvers hold the whole feature honest, so they are pinned here
 * rather than through the App tree:
 *
 * - resolveAccountIndicator decides what the session header may claim. The
 *   thing it must never do is present the database assignment as the account
 *   actually in use — that is the lie #164's first symptom was made of, where
 *   switching a live session made every surface agree instantly while the old
 *   account kept being billed.
 * - accountMenuLabel decides how an account is named in the two context menus,
 *   which cannot render a swatch and therefore have to identify an account in
 *   text alone.
 *
 * Run with: bun test src/renderer/__tests__/App.accounts.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  accountMenuLabel,
  defaultAccountMenuLabel,
  resolveAccountIndicator,
  respawnable,
} from '../App';
import type { ClaudeAccount, LiveAccountBinding, Session } from '../../shared/types';

const work = {
  id: 'a-work', label: 'Work', email: 'will@acme.test', color: '#61afef',
  configDir: '/cfg/work', isDefault: false,
} as ClaudeAccount;

const personal = {
  id: 'a-personal', label: 'Personal', email: null, color: '#98c379',
  configDir: '/cfg/personal', isDefault: true,
} as ClaudeAccount;

const accounts = [work, personal];

const claudeSession = {
  id: 's1', groupId: 'g1', name: 'login flow', workingDir: '/repo',
  state: 'idle', shellType: 'claude', provider: 'claude',
  claudeAccountId: null,
} as Session;

function bindingFor(accountId: string | null): LiveAccountBinding {
  return { accountId, configDir: accountId ? `/cfg/${accountId}` : '/home/.claude', spawnedAt: 1 };
}

const noop = () => {};

function resolve(overrides: {
  session?: Session;
  accounts?: ClaudeAccount[];
  binding?: LiveAccountBinding;
  assignedAccount?: ClaudeAccount | null;
} = {}) {
  return resolveAccountIndicator({
    session: overrides.session ?? claudeSession,
    accounts: overrides.accounts ?? accounts,
    binding: overrides.binding,
    assignedAccount: overrides.assignedAccount ?? null,
    onApplySwitch: noop,
  });
}

describe('resolveAccountIndicator', () => {
  test('renders nothing when no accounts are registered', () => {
    expect(resolve({ accounts: [] })).toBeNull();
  });

  test('a pty still bound to the only account the user just deleted keeps its indicator', () => {
    // Deleting the last account empties the list AND removes the config dir out
    // from under a running Claude Code. Falling back to the pre-accounts look
    // there hides the one session that most needs explaining: alive, billing a
    // login that no longer exists, and told nothing.
    const props = resolve({ accounts: [], binding: bindingFor(work.id) })!;
    expect(props).not.toBeNull();
    expect(props.liveAccountUnknown).toBe(true);
    expect(props.isRunning).toBe(true);
  });

  test('a legacy-login pty with no accounts registered still shows nothing', () => {
    // binding.accountId === null is the pre-accounts world, not a deletion.
    expect(resolve({ accounts: [], binding: bindingFor(null) })).toBeNull();
  });

  test('renders nothing for a plain shell session', () => {
    const shell = { ...claudeSession, shellType: 'shell' } as Session;
    expect(resolve({ session: shell })).toBeNull();
  });

  test('renders nothing for a non-Claude provider, which never publishes a binding', () => {
    const codex = { ...claudeSession, provider: 'codex' } as Session;
    expect(resolve({ session: codex })).toBeNull();
  });

  test('a running pty names the account it actually spawned under', () => {
    const props = resolve({ binding: bindingFor(work.id), assignedAccount: work })!;
    expect(props.isRunning).toBe(true);
    expect(props.liveAccount).toBe(work);
    expect(props.liveAccountUnknown).toBe(false);
  });

  test('a switch not yet applied keeps live and assigned apart', () => {
    // The pty is still on Work; the database already says Personal. Reporting
    // Personal here is precisely the failure #165 exists to prevent.
    const props = resolve({ binding: bindingFor(work.id), assignedAccount: personal })!;
    expect(props.liveAccount).toBe(work);
    expect(props.assignedAccount).toBe(personal);
  });

  test('no binding means no pty, whatever the session row says', () => {
    const props = resolve({ assignedAccount: work })!;
    expect(props.isRunning).toBe(false);
    expect(props.liveAccount).toBeNull();
    expect(props.assignedAccount).toBe(work);
  });

  test('a pty on a deleted account is flagged rather than silently shown as legacy', () => {
    const props = resolve({ binding: bindingFor('a-deleted'), assignedAccount: work })!;
    expect(props.liveAccount).toBeNull();
    expect(props.liveAccountUnknown).toBe(true);
    expect(props.isRunning).toBe(true);
  });

  test('a pty with no config dir is the legacy login, not an unknown account', () => {
    const props = resolve({ binding: bindingFor(null), assignedAccount: work })!;
    expect(props.liveAccount).toBeNull();
    expect(props.liveAccountUnknown).toBe(false);
    expect(props.isRunning).toBe(true);
  });

  test('isOverride distinguishes a session-level pick from an inherited one', () => {
    expect(resolve()!.isOverride).toBe(false);
    const pinned = { ...claudeSession, claudeAccountId: work.id } as Session;
    expect(resolve({ session: pinned })!.isOverride).toBe(true);
  });

  test('the live account is joined by id, so a rename needs no respawn', () => {
    const renamed = { ...work, label: 'Acme Corp' } as ClaudeAccount;
    const props = resolve({ accounts: [renamed, personal], binding: bindingFor(work.id) })!;
    expect(props.liveAccount?.label).toBe('Acme Corp');
  });
});

/**
 * The group menu's "use the default" item (#213).
 *
 * It clears the assignment rather than setting one, and during a usage limit
 * the account it resolves to is usually the one the user is trying to get off.
 * An unnamed destination one row above the account list is what let a group
 * silently go back onto a spent account.
 */
describe('defaultAccountMenuLabel', () => {
  test('names the account the item actually resolves to', () => {
    expect(defaultAccountMenuLabel([work, personal], false)).toContain('Personal');
  });

  test('says only what it knows when no account is marked default', () => {
    const label = defaultAccountMenuLabel([{ ...work, isDefault: false } as ClaudeAccount], false);
    expect(label).toContain('Use default account');
    expect(label).not.toContain('(');
  });

  test('is ticked when the group is already on the default', () => {
    expect(defaultAccountMenuLabel([work, personal], true).startsWith('✓ ')).toBe(true);
  });
});

describe('accountMenuLabel', () => {
  test('carries the email, so two accounts sharing a label stay distinguishable', () => {
    const other = { ...work, id: 'a-other', email: 'will@other.test' } as ClaudeAccount;
    const a = accountMenuLabel(work, false);
    const b = accountMenuLabel(other, false);
    expect(a).toContain('will@acme.test');
    expect(b).toContain('will@other.test');
    expect(a).not.toBe(b);
  });

  test('an account resolved as logged out says so instead of trailing off', () => {
    const fresh = { ...personal, loggedIn: false } as ClaudeAccount;
    expect(accountMenuLabel(fresh, false)).toContain('not yet logged in');
  });

  // A login that records no address is still a login, and on macOS that is the
  // normal case rather than the exception.
  test('a logged-in account that recorded no address is not called logged out', () => {
    const noAddress = { ...personal, loggedIn: true } as ClaudeAccount;
    expect(accountMenuLabel(noAddress, false)).not.toContain('not yet logged in');
    expect(accountMenuLabel(noAddress, false)).toContain('Use "Personal"');
  });

  test('an unresolved account withholds the claim rather than guessing at it', () => {
    expect(accountMenuLabel(personal, false)).not.toContain('not yet logged in');
  });

  test('the default account is marked, and the current one is ticked', () => {
    expect(accountMenuLabel(personal, false)).toContain('(default)');
    expect(accountMenuLabel(work, true).startsWith('✓ ')).toBe(true);
    expect(accountMenuLabel(work, false).startsWith('✓')).toBe(false);
  });

  test('the label stays quoted, so an account named after a verb still reads', () => {
    const odd = { ...work, label: 'Use' } as ClaudeAccount;
    expect(accountMenuLabel(odd, false)).toContain('Use "Use"');
  });
});

/**
 * Which of the sessions an automatic switch moved actually get their pty
 * replaced (#207).
 *
 * Both directions are mistakes the user sees. Restarting a stopped session
 * starts something they deliberately ended; skipping a live one leaves it
 * billing the account that just ran dry, which is the entire thing failover
 * exists to stop.
 */
describe('respawnable', () => {
  const session = (id: string, state: string) => ({ id, state } as Session);

  test('keeps the sessions that still have a pty', () => {
    const sessions = [session('a', 'working'), session('b', 'waiting'), session('c', 'idle')];
    expect(respawnable(['a', 'b', 'c'], sessions)).toEqual(['a', 'b', 'c']);
  });

  test('drops a stopped session rather than starting it back up', () => {
    const sessions = [session('a', 'working'), session('b', 'stopped')];
    expect(respawnable(['a', 'b'], sessions)).toEqual(['a']);
  });

  /**
   * A moved session the renderer has not heard of yet is restarted, not
   * dropped. Only an explicit 'stopped' is evidence there is nothing to
   * replace; absence is evidence of nothing.
   */
  test('keeps an id the renderer has no row for', () => {
    expect(respawnable(['ghost'], [session('a', 'working')])).toEqual(['ghost']);
  });

  test('moves nothing when nothing moved', () => {
    expect(respawnable([], [session('a', 'working')])).toEqual([]);
  });
});
