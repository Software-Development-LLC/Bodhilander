/**
 * Linking this machine to Crew: a signed request for a link code, then the
 * person signs in on the Hub's link page and approves the link card in Teams.
 * Only a person's click requests a code; nothing here retries on its own
 * except one re-sign for clock-skew or replayed.
 */
import { isUuidV4 } from './protocol-parse';
import {
  linkMessage,
  type LinkCodeConflict,
  type LinkCodeError,
  type LinkCodeRequest,
  type LinkCodeResponse,
} from './protocol';

export interface LinkKeys {
  ed25519Pub: string;
  x25519Pub: string;
}

export interface LinkDeps {
  hubUrl: string;
  keys: LinkKeys;
  name: string;
  sign(message: Uint8Array): Buffer;
  now(): number;
  fetch(url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;
}

export type LinkResult =
  | { kind: 'code'; code: string; confirmCode: string; machineId: string; linkUrl: string }
  | { kind: 'already-linked'; machineId: string; ownerName: string; ownerUpn: string }
  | { kind: 'rate-limited'; retryAfterSeconds: number | null }
  | { kind: 'cannot-link'; error: string }
  | { kind: 'unreadable' }
  | { kind: 'failed'; status: number }
  | { kind: 'unreachable' };

const CONFIRM_CODE = /^[A-Za-z0-9]{6}$/;

export function buildLinkRequest(deps: Pick<LinkDeps, 'hubUrl' | 'keys' | 'name' | 'sign'>, issuedAt: number): LinkCodeRequest {
  const hubHost = new URL(deps.hubUrl).host;
  const { ed25519Pub, x25519Pub } = deps.keys;
  const toSign = linkMessage(hubHost, ed25519Pub, x25519Pub, issuedAt, deps.name);
  const sig = deps.sign(new TextEncoder().encode(toSign)).toString('base64');
  return { name: deps.name, ed25519Pub, x25519Pub, issuedAt, sig };
}

function readCode(body: unknown, hubUrl: string): LinkResult {
  const b = (body ?? {}) as Partial<LinkCodeResponse>;
  if (typeof b.code !== 'string' || b.code.length === 0) return { kind: 'unreadable' };
  if (typeof b.confirmCode !== 'string' || !CONFIRM_CODE.test(b.confirmCode)) return { kind: 'unreadable' };
  if (!isUuidV4(b.machineId)) return { kind: 'unreadable' };
  const linkUrl = `${hubUrl}/link?code=${encodeURIComponent(b.code)}`;
  return { kind: 'code', code: b.code, confirmCode: b.confirmCode, machineId: b.machineId, linkUrl };
}

function readConflict(body: unknown): LinkResult {
  const b = (body ?? {}) as Partial<LinkCodeConflict>;
  if (b.error !== 'already-linked' || !isUuidV4(b.machineId)) return { kind: 'unreadable' };
  if (typeof b.ownerName !== 'string' || typeof b.ownerUpn !== 'string') return { kind: 'unreadable' };
  return { kind: 'already-linked', machineId: b.machineId, ownerName: b.ownerName, ownerUpn: b.ownerUpn };
}

async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** POST /link/codes. Validates the answer before the caller stores or opens anything. */
export async function requestLinkCode(deps: LinkDeps): Promise<LinkResult> {
  const hubUrl = deps.hubUrl.replace(/\/+$/, '');
  let issuedAt = deps.now();
  let skewRetried = false;
  let replayRetried = false;
  for (;;) {
    let res: Awaited<ReturnType<LinkDeps['fetch']>>;
    try {
      res = await deps.fetch(`${hubUrl}/link/codes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildLinkRequest({ ...deps, hubUrl }, issuedAt)),
      });
    } catch {
      return { kind: 'unreachable' };
    }

    if (res.status === 200 || res.status === 201) return readCode(await readJson(res), hubUrl);
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      return { kind: 'rate-limited', retryAfterSeconds: Number.isFinite(after) && after > 0 ? after : null };
    }

    const body = await readJson(res);
    const error = (body as Partial<LinkCodeError> | undefined)?.error;
    if (res.status === 409 && error === 'already-linked') return readConflict(body);

    if (!skewRetried && error === 'clock-skew') {
      const hubTime = (body as Partial<LinkCodeError>).hubTime;
      if (typeof hubTime !== 'number' || !Number.isSafeInteger(hubTime)) return { kind: 'unreadable' };
      skewRetried = true;
      issuedAt = hubTime;
      continue;
    }
    if (!replayRetried && error === 'replayed') {
      replayRetried = true;
      issuedAt = Math.max(deps.now(), issuedAt + 1);
      continue;
    }
    if (typeof error === 'string') return { kind: 'cannot-link', error };
    return { kind: 'failed', status: res.status };
  }
}

export interface LinkFlowDeps extends LinkDeps {
  storeMachineId(machineId: string): void;
  openExternal(url: string): void;
  connect(): void;
}

export type LinkView =
  | { step: 'show-codes'; name: string; confirmCode: string }
  | { step: 'confirm-owner'; ownerName: string; ownerUpn: string }
  | { step: 'stopped'; result: LinkResult };

/** One click of Link this machine. A conflict waits for confirmOwner before anything is stored. */
export class LinkFlow {
  private conflict: { machineId: string } | null = null;

  constructor(private readonly deps: LinkFlowDeps) {}

  async begin(): Promise<LinkView> {
    this.conflict = null;
    const result = await requestLinkCode(this.deps);
    if (result.kind === 'code') {
      this.deps.storeMachineId(result.machineId);
      this.deps.openExternal(result.linkUrl);
      this.deps.connect();
      return { step: 'show-codes', name: this.deps.name, confirmCode: result.confirmCode };
    }
    if (result.kind === 'already-linked') {
      this.conflict = { machineId: result.machineId };
      return { step: 'confirm-owner', ownerName: result.ownerName, ownerUpn: result.ownerUpn };
    }
    return { step: 'stopped', result };
  }

  /** "This machine is linked to ..." answered. Not me stores and connects nothing. */
  confirmOwner(isMe: boolean): boolean {
    const pending = this.conflict;
    this.conflict = null;
    if (!pending || !isMe) return false;
    this.deps.storeMachineId(pending.machineId);
    this.deps.connect();
    return true;
  }
}
