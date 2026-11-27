/**
 * Strict parsing of Hub frames. A frame is refused, never coerced: a missing
 * or mistyped field drops the whole frame rather than defaulting it.
 */
import {
  EDIT_RESULTS,
  ERROR_REASONS,
  HUB_FRAME_TYPES,
  MACHINE_FRAME_TYPES,
  MAX_FRAME_BYTES,
  MAX_TEXT,
  REFUSED_REASONS,
  SYNC_KINDS,
  parseMachineFrame,
  type HubFrame,
  type HubFrameType,
  type MachineFrame,
  type Lease,
} from './protocol';

export type ParseResult =
  | { ok: true; frame: HubFrame }
  | { ok: false; problem: 'not-json' | 'too-large' | 'unknown-type' | 'bad-shape'; type?: string };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isEpoch = (v: unknown): v is number => isInt(v) && v >= 0;

type Obj = Record<string, unknown>;

function checkLeases(v: unknown): v is Lease[] {
  return Array.isArray(v) && v.every((l) => typeof l === 'object' && l !== null && isUuidV4((l as Obj).hireId) && isEpoch((l as Obj).epoch));
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function isSyncObject(v: unknown): boolean {
  return (
    isObj(v) &&
    (SYNC_KINDS as readonly string[]).includes(v.kind as string) &&
    isNonEmpty(v.objectId) &&
    isEpoch(v.rev) &&
    isEpoch(v.seq) &&
    isNonEmpty(v.hash) &&
    typeof v.deleted === 'boolean' &&
    (v.body === undefined || isObj(v.body))
  );
}

const SHAPES: Partial<Record<HubFrameType, (f: Obj) => boolean>> = {
  challenge: (f) => isInt(f.version) && isNonEmpty(f.nonce) && isEpoch(f.hubTime),
  welcome: (f) => isUuidV4(f.machineId) && isEpoch(f.hubTime) && isStr(f.ownerName) && isStr(f.ownerUpn),
  deliver: (f) =>
    isUuidV4(f.id) &&
    isUuidV4(f.hireId) &&
    isEpoch(f.epoch) &&
    (f.scope === 'owner' || f.scope === 'circle') &&
    isUuidV4(f.requestedBy) &&
    isStr(f.text) &&
    f.text.length <= MAX_TEXT &&
    isStr(f.from),
  ack: (f) => isNonEmpty(f.id),
  renew: (f) => isInt(f.seq) && isEpoch(f.hubTime) && checkLeases(f.leases),
  refused: (f) => isNonEmpty(f.id) && isNonEmpty(f.reason),
  lease_revoke: (f) => isUuidV4(f.hireId) && isNonEmpty(f.mode),
  error: (f) => isNonEmpty(f.reason),
  change: (f) => isEpoch(f.seq),
  sync_page: (f) =>
    isUuidV4(f.id) && Array.isArray(f.changes) && f.changes.every(isSyncObject) && isEpoch(f.next) && typeof f.more === 'boolean',
  edit_result: (f) =>
    isUuidV4(f.id) &&
    (EDIT_RESULTS as readonly string[]).includes(f.result as string) &&
    (f.objectId === undefined || isNonEmpty(f.objectId)) &&
    (f.rev === undefined || isEpoch(f.rev)) &&
    (f.why === undefined || isStr(f.why)) &&
    (f.current === undefined || isSyncObject(f.current)),
  artifact: (f) => isUuidV4(f.id) && isNonEmpty(f.name) && isNonEmpty(f.url) && isEpoch(f.expiresAt),
  card_decision: (f) =>
    isUuidV4(f.id) && isUuidV4(f.hireId) && isEpoch(f.epoch) && isUuidV4(f.raiseId) && (f.decision === 'approved' || f.decision === 'denied') && isNonEmpty(f.decidedBy),
  token: (f) => isUuidV4(f.id) && isNonEmpty(f.token) && isEpoch(f.expiresAt) && Array.isArray(f.repos) && f.repos.every(isNonEmpty),
  usage: (f) =>
    isUuidV4(f.id) &&
    isUuidV4(f.hireId) &&
    isEpoch(f.since) &&
    isEpoch(f.inputTokens) &&
    isEpoch(f.outputTokens) &&
    isEpoch(f.cacheCreationTokens) &&
    isEpoch(f.records),
};

/**
 * `refused.reason`, `error.reason` and `lease_revoke.mode` outside their sets
 * still parse: the caller has a rule for an unknown value, and dropping the
 * frame would lose the id it needs to apply it.
 */
export function parseHubFrame(raw: string): ParseResult {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return { ok: false, problem: 'too-large' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, problem: 'not-json' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, problem: 'bad-shape' };
  const f = data as Obj;
  const type = f.type;
  if (!isStr(type) || !(HUB_FRAME_TYPES as readonly string[]).includes(type)) {
    return { ok: false, problem: 'unknown-type', type: isStr(type) ? type : undefined };
  }
  const known = type as HubFrameType;
  const shape = SHAPES[known];
  if (!shape?.(f)) return { ok: false, problem: 'bad-shape', type };
  return { ok: true, frame: f as unknown as HubFrame };
}

export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

export const isRefusedReason = (r: string): boolean => (REFUSED_REASONS as readonly string[]).includes(r);
export const isErrorReason = (r: string): boolean => (ERROR_REASONS as readonly string[]).includes(r);

/** The runtime half of the send guard; the union type is the compile-time half. */
export function assertSendable(frame: MachineFrame): string {
  if (!(MACHINE_FRAME_TYPES as readonly string[]).includes((frame as { type: string }).type)) {
    throw new Error(`refusing to send a frame of type ${(frame as { type: string }).type}`);
  }
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error(`refusing to send a ${frame.type} frame over MAX_FRAME_BYTES`);
  }
  if (!parseMachineFrame(text).ok) throw new Error(`refusing to send a ${frame.type} frame the Hub would refuse malformed`);
  return text;
}

const CUT_NOTICE = '\n… (cut at 28,000 characters)';

/** Cut text to MAX_TEXT with the notice inside the limit, never splitting a surrogate pair. */
export function cutText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  let end = MAX_TEXT - CUT_NOTICE.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + CUT_NOTICE;
}
