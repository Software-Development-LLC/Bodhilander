import { describe, expect, test } from 'bun:test';
import type { Request, Response } from 'express';
import { validatePairingConfirm } from '../middleware/validation';

function confirm(body: Record<string, unknown>) {
  let status = 200;
  let payload: unknown = null;
  let passed = false;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { payload = value; return this; },
  } as unknown as Response;
  validatePairingConfirm({ body } as Request, res, () => { passed = true; });
  return { status, payload, passed };
}

describe('validatePairingConfirm', () => {
  test('a phone pairs as usual', () => {
    expect(confirm({ code: '123456', deviceName: 'Phone', platform: 'ios' }).passed).toBe(true);
  });

  test('the Claude Desktop platform cannot be claimed through a pairing code', () => {
    const result = confirm({ code: '123456', deviceName: 'Sneaky', platform: 'claude-desktop' });
    expect(result.passed).toBe(false);
    expect(result.status).toBe(400);
    expect(result.payload).toMatchObject({ field: 'platform' });
    expect(confirm({ code: '123456', deviceName: 'Sneaky', platform: 'Claude-Desktop' }).passed).toBe(false);
  });
});
