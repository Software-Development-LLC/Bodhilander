import { describe, expect, test } from 'bun:test';
import { parseDiscovery, serializeDiscovery, userDataCandidates } from '../claude-desktop';

describe('userDataCandidates', () => {
  test('Windows reads APPDATA, installed app first', () => {
    expect(userDataCandidates('win32', { APPDATA: 'C:\\Users\\w\\AppData\\Roaming' }, 'C:\\Users\\w')).toEqual([
      'C:\\Users\\w\\AppData\\Roaming\\bodhilander',
      'C:\\Users\\w\\AppData\\Roaming\\Bodhilander',
      'C:\\Users\\w\\AppData\\Roaming\\bodhilander\\dev',
      'C:\\Users\\w\\AppData\\Roaming\\Bodhilander\\dev',
    ]);
  });

  test('Windows without APPDATA falls back under the home directory', () => {
    expect(userDataCandidates('win32', {}, 'C:\\Users\\w')[0]).toBe('C:\\Users\\w\\AppData\\Roaming\\bodhilander');
  });

  test('macOS uses Application Support', () => {
    expect(userDataCandidates('darwin', {}, '/Users/w')[0]).toBe('/Users/w/Library/Application Support/bodhilander');
  });

  test('Linux honours XDG_CONFIG_HOME, else ~/.config', () => {
    expect(userDataCandidates('linux', { XDG_CONFIG_HOME: '/x' }, '/home/w')[0]).toBe('/x/bodhilander');
    expect(userDataCandidates('linux', {}, '/home/w')[0]).toBe('/home/w/.config/bodhilander');
  });
});

describe('discovery file', () => {
  test('what the writer serializes, the reader parses', () => {
    const file = { version: 1 as const, port: 8443, credentialPath: '/u/claude-desktop/credential' };
    expect(parseDiscovery(serializeDiscovery(file))).toEqual(file);
  });

  test.each([
    ['not json', '{'],
    ['another version', JSON.stringify({ version: 2, port: 1, credentialPath: '/c' })],
    ['a port out of range', JSON.stringify({ version: 1, port: 70000, credentialPath: '/c' })],
    ['a fractional port', JSON.stringify({ version: 1, port: 80.5, credentialPath: '/c' })],
    ['no credential path', JSON.stringify({ version: 1, port: 80 })],
    ['null', 'null'],
  ])('rejects %s', (_label, text) => {
    expect(parseDiscovery(text)).toBeNull();
  });
});
