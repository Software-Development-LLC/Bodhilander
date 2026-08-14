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
import { accountMenuLabel, resolveAccountIndicator } from '../App';
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

describe('accountMenuLabel', () => {
  test('carries the email, so two accounts sharing a label stay distinguishable', () => {
    const other = { ...work, id: 'a-other', email: 'will@other.test' } as ClaudeAccount;
    const a = accountMenuLabel(work, false);
    const b = accountMenuLabel(other, false);
    expect(a).toContain('will@acme.test');
    expect(b).toContain('will@other.test');
    expect(a).not.toBe(b);
  });

  test('an account with no email says so instead of trailing off', () => {
    expect(accountMenuLabel(personal, false)).toContain('not yet logged in');
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
