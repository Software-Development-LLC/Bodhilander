import { describe, expect, test } from 'bun:test';
import { announceSignInStart, SIGN_IN_STARTED_CHANNEL } from '../sign-in-started';

describe('announcing the sign in pty', () => {
  test('tells the renderer which pty the login started, and hands the start back unchanged', () => {
    const sent: unknown[] = [];
    const resume = announceSignInStart((id) => ({ ptyId: `pty-${id}` }), (channel, data) => sent.push([channel, data]));
    expect(resume('a1')).toEqual({ ptyId: 'pty-a1' });
    expect(sent).toEqual([[SIGN_IN_STARTED_CHANNEL, { accountId: 'a1', ptyId: 'pty-a1' }]]);
    expect(SIGN_IN_STARTED_CHANNEL).toBe('crew:signInStarted');
  });

  test('a login that could not start announces nothing', () => {
    const sent: unknown[] = [];
    const resume = announceSignInStart(() => {
      throw new Error('no pty');
    }, (channel, data) => sent.push([channel, data]));
    expect(() => resume('a1')).toThrow('no pty');
    expect(sent).toEqual([]);
  });
});
