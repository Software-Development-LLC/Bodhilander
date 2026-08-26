/**
 * The forcing function behind the export allowlist (#227).
 *
 * Switching to an allowlist makes an unclassified preference stay home, which
 * is the safe default but a silent one: a legitimate new setting would quietly
 * stop travelling between machines and nobody would find out until a user
 * noticed their choice had not followed them.
 *
 * So this test reads the source for preference keys and fails on any key that
 * is on neither list. It is a lint rather than a unit test, and that is the
 * point — it makes "I added a preference" a decision someone has to write
 * down, in the file where the consequence lives.
 *
 * It can only see keys written as literals. Computed ones
 * (`providerApiKey.${id}`) live under namespaces covered by the prefix list,
 * which is why prefixes count as a classification here.
 *
 * Run with: bun test src/main/transfer/__tests__
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isClassifiedPreferenceKey, isPortablePreferenceKey } from '../bundle-format';

const SRC = path.resolve(import.meta.dir, '../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every preference key the source names as a literal, whether through a direct
 * get/setPreference call or through a `const SOMETHING_PREF = '...'` binding.
 */
function declaredPreferenceKeys(): Map<string, string> {
  const found = new Map<string, string>();
  const patterns = [
    /(?:get|set)Preference\(\s*'([^']+)'/g,
    // Name must END in PREF / PREF_KEY. A `*_PREFIX` constant is a namespace,
    // not a key — those are covered by the prefix list, and matching them here
    // dragged in unrelated things like TRANSCRIPT_PREFIX.
    /(?:const|readonly)\s+[A-Za-z0-9_]*PREF(?:_KEY)?\s*(?::[^=]+)?=\s*'([^']+)'/g,
  ];

  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        const key = m[1]!;
        // A prefix constant is a namespace, not a key; the prefix list covers it.
        if (key.endsWith('.')) continue;
        if (!found.has(key)) found.set(key, path.relative(SRC, file));
      }
    }
  }
  return found;
}

describe('every preference key is classified for export', () => {
  test('the scan finds the keys it is supposed to be guarding', () => {
    // Guards the guard: a regex that silently matched nothing would make this
    // whole file pass forever while classifying nothing.
    const keys = declaredPreferenceKeys();
    expect(keys.size).toBeGreaterThan(10);
    expect([...keys.keys()]).toContain('fontSize');
    expect([...keys.keys()]).toContain('teamsTokens');
  });

  test('no preference key is left undecided', () => {
    const unclassified = [...declaredPreferenceKeys()]
      .filter(([key]) => !isClassifiedPreferenceKey(key))
      .map(([key, file]) => `${key}  (${file})`);

    expect(unclassified).toEqual([]);
  });
});

describe('the allowlist itself', () => {
  test('an unknown key stays home rather than travelling by default', () => {
    expect(isPortablePreferenceKey('somethingAddedNextYear')).toBe(false);
    expect(isPortablePreferenceKey('')).toBe(false);
  });

  test('the settings a user chose still travel', () => {
    for (const key of ['fontSize', 'soundVolume', 'enableNotifications', 'updateChannel']) {
      expect(isPortablePreferenceKey(key)).toBe(true);
    }
  });

  test('secrets and machine-shaped settings do not', () => {
    for (const key of [
      'teamsTokens',
      'windowBounds',
      'customShellPath',
      'soundErrorCustomPath',
      'providerApiKey.anthropic',
      'providerApiKeyUse.anthropic',
      'relay.ed25519Priv',
      'relay.ownerUserId',
    ]) {
      expect(isPortablePreferenceKey(key)).toBe(false);
    }
  });

  test('a one-time migration marker never travels, including the one that used to', () => {
    // quotaCooldownsCleared was exported under the denylist purely because
    // nobody added it — the exact failure the allowlist exists to stop.
    for (const key of [
      'quotaCooldownsCleared',
      'legacyCodeSearchCleanupDone',
      'legacyMemoryCleanupDone',
      'legacyMemoryMcpCleanupDone',
    ]) {
      expect(isPortablePreferenceKey(key)).toBe(false);
      expect(isClassifiedPreferenceKey(key)).toBe(true);
    }
  });
});
