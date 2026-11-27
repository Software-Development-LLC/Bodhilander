/**
 * A signed request for a link code, made only on a person's click. The one retry
 * is a single re-sign each for clock-skew and replayed.
 */
import { isUuidV4, trimTrailingSlashes } from './protocol-parse';
import { linkMessage, type LinkError } from './protocol';

// The POST /link/codes bodies, as bodhi-service-crew src/machines/link.ts declares them.
export type LinkCodeRequest = { name: string; ed25519Pub: string; x25519Pub: string; issuedAt: number; sig: string };
export type LinkCodeResponse = { code: string; confirmCode: string; machineId: string };
export type LinkCodeConflict = { error: 'already-linked'; machineId: string; ownerName: string; ownerUpn: string };
export type LinkCodeError = { error: Exclude<LinkError, 'already-linked'>; hubTime: number };

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

type Attempt = { done: LinkResult } | { retry: 'clock-skew'; hubTime: unknown } | { retry: 'replayed' };

async function postOnce(deps: LinkDeps, hubUrl: string, issuedAt: number): Promise<Attempt> {
  let res: Awaited<ReturnType<LinkDeps['fetch']>>;
  try {
    res = await deps.fetch(`${hubUrl}/link/codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildLinkRequest({ ...deps, hubUrl }, issuedAt)),
    });
  } catch {
    return { done: { kind: 'unreachable' } };
  }
  if (res.status === 200 || res.status === 201) return { done: readCode(await readJson(res), hubUrl) };
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    return { done: { kind: 'rate-limited', retryAfterSeconds: Number.isFinite(after) && after > 0 ? after : null } };
  }
  const body = (await readJson(res)) as Partial<LinkCodeError> | Partial<LinkCodeConflict> | undefined;
  const error = body?.error;
  if (res.status === 409 && error === 'already-linked') return { done: readConflict(body) };
  if (error === 'clock-skew') return { retry: error, hubTime: (body as Partial<LinkCodeError>).hubTime };
  if (error === 'replayed') return { retry: error };
  if (typeof error === 'string') return { done: { kind: 'cannot-link', error } };
  return { done: { kind: 'failed', status: res.status } };
}

/** POST /link/codes. Validates the answer before the caller stores or opens anything. */
export async function requestLinkCode(deps: LinkDeps): Promise<LinkResult> {
  const hubUrl = trimTrailingSlashes(deps.hubUrl);
  let issuedAt = deps.now();
  const retried = new Set<string>();
  for (;;) {
    const attempt = await postOnce(deps, hubUrl, issuedAt);
    if ('done' in attempt) return attempt.done;
    if (retried.has(attempt.retry)) return { kind: 'cannot-link', error: attempt.retry };
    retried.add(attempt.retry);
    if (attempt.retry === 'replayed') {
      // After a skew retry the Hub's clock is the one to stay on.
      issuedAt = retried.has('clock-skew') ? issuedAt + 1 : Math.max(deps.now(), issuedAt + 1);
    } else if (typeof attempt.hubTime === 'number' && Number.isSafeInteger(attempt.hubTime)) {
      issuedAt = attempt.hubTime;
    } else {
      return { kind: 'unreadable' };
    }
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
