// Copied verbatim from bodhi-service-crew src/protocol.ts at 1c49e41 (branch feat/1498-service-crew, head c64961ae905999afc62f02f82452c3da683e5984).
// The machine protocol between the Crew Hub and Bodhilander, which keeps a verbatim copy at
// src/main/crew/protocol.ts. Any frame change after phase 1 ships bumps PROTOCOL_VERSION.
// Times (*At, hubTime) are epoch ms; every id on the wire is a lowercase UUIDv4; MAX_TEXT counts
// UTF-16 code units, as JavaScript's `length` does.

export const PROTOCOL_VERSION = 2;

export const MAX_TEXT = 28_000;
export const MAX_FRAME_BYTES = 262_144;
export const FILE_CHUNK_BYTES = 98_304;
export const FILE_MAX_BYTES = 26_214_400;
export const HEARTBEAT_MS = 30_000;
export const OFFLINE_AFTER_MS = 90_000;
export const LEASE_MS = 300_000;
export const AUTH_TIMEOUT_MS = 10_000;
export const LINK_SKEW_MS = 300_000;
export const MAX_NAME = 64;
export const MAX_SKILL_BYTES = 1_048_576;

// ---- value sets ----------------------------------------------------------------------------------

export const MACHINE_FRAME_TYPES = [
  'auth',
  'ack',
  'heartbeat',
  'reply',
  'typing',
  'lease_revoked',
  'file',
  'send',
  'card_raise',
  'usage_record',
  'usage_read',
  'sync_pull',
  'edit',
  'note_write',
  'routine_fired',
  'token_request',
  'audit',
  'unlink',
  'artifact_request',
] as const;
export type MachineFrameType = (typeof MACHINE_FRAME_TYPES)[number];

export const HUB_FRAME_TYPES = [
  'challenge',
  'welcome',
  'deliver',
  'ack',
  'renew',
  'refused',
  'lease_revoke',
  'error',
  'change',
  'sync_page',
  'edit_result',
  'card_decision',
  'usage',
  'token',
  'artifact',
] as const;
export type HubFrameType = (typeof HUB_FRAME_TYPES)[number];

// Every refused.reason (design §4.1). Each is final: the machine drops the item.
export const REFUSED_REASONS = [
  'stale-epoch',
  'not-home',
  'unknown',
  'wrong-hire',
  'closed',
  'scope',
  'paused',
  'malformed',
] as const;
export type RefusedReason = (typeof REFUSED_REASONS)[number];

// Every connection-level error.reason, sent just before the close (design §6.1 "Connecting").
export const ERROR_REASONS = ['protocol-version', 'bad-auth', 'pending', 'unlinked', 'auth-timeout', 'replaced'] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number];

export const CLOSE_CODES: Record<ErrorReason, number> = {
  'protocol-version': 4426,
  'bad-auth': 4401,
  pending: 4403,
  unlinked: 4410,
  'auth-timeout': 4408,
  replaced: 4409,
};
// Closes that carry no error frame: an internal Hub failure, and ten bad frames in one connection.
export const CLOSE_INTERNAL = 1011;
export const CLOSE_TOO_MANY_BAD_FRAMES = 1008;
export const BAD_FRAME_LIMIT = 10;

// Every error a POST /link/codes answer can carry.
export const LINK_ERRORS = ['bad-request', 'bad-signature', 'clock-skew', 'replayed', 'already-linked'] as const;
export type LinkError = (typeof LINK_ERRORS)[number];

export const RUN_SCOPES = ['owner', 'circle'] as const;
export type RunScope = (typeof RUN_SCOPES)[number];

export const LEASE_MODES = ['drop', 'pause'] as const;
export type LeaseMode = (typeof LEASE_MODES)[number];

// The card kinds a machine may raise in phase 1 (design §7). `link` is raised by the Hub only.
export const MACHINE_CARD_KINDS = ['permission', 'skill_change', 'note_patch', 'move'] as const;
export type MachineCardKind = (typeof MACHINE_CARD_KINDS)[number];

export const CARD_DECISIONS = ['approved', 'denied'] as const;
export type CardDecision = (typeof CARD_DECISIONS)[number];

// The automatic holds a home machine reports with an `audit` frame (event `hold`, design §6.3).
export const HOLD_STATES = [
  'held:missing',
  'held:signed-out',
  'held:rate-limited',
  'held:crew-cap',
  'held:hire-cap',
  'held:setup',
] as const;
export type HoldState = (typeof HOLD_STATES)[number];

// Every hire.state (design §6.3).
export const HIRE_STATES = [
  'provisioning',
  'provisioning:waiting-admin',
  'provisioning:failed',
  'active',
  ...HOLD_STATES,
  'held:no-home',
  'paused:backstop',
  'paused:rollback',
  'let_go',
] as const;
export type HireState = (typeof HIRE_STATES)[number];

export const SYNC_KINDS = ['hire', 'role', 'skill_bundle', 'routine', 'note'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

// The kinds a machine may edit (design §9). Roles are code (H3b) and notes go through note_write.
export const EDIT_KINDS = ['hire', 'routine', 'skill_bundle'] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

export const EDIT_OPS = ['create', 'update', 'delete'] as const;
export type EditOp = (typeof EDIT_OPS)[number];

export const EDIT_RESULTS = ['applied', 'conflict', 'refused'] as const;
export type EditResult = (typeof EDIT_RESULTS)[number];

// ---- the two signed messages ---------------------------------------------------------------------

// Signed by the machine key on /ws. hubHost is the host the machine dialled.
export const authMessage = (hubHost: string, machineId: string, nonce: string) =>
  `bodhi-crew-hub-auth-v1:${hubHost}:${machineId}:${nonce}`;

// Signed by the machine key on POST /link/codes. name comes last and holds no control character.
export const linkMessage = (hubHost: string, ed25519Pub: string, x25519Pub: string, issuedAt: number, name: string) =>
  `bodhi-crew-link-v1\n${hubHost}\n${ed25519Pub}\n${x25519Pub}\n${issuedAt}\n${name}`;

// ---- machine -> Hub frames -----------------------------------------------------------------------

export type AuthFrame = { type: 'auth'; version: number; machineId: string; sig: string };
// Both directions: the machine acks a deliver or card_decision; the Hub acks a committed machine frame.
export type AckFrame = { type: 'ack'; id: string };
export type HeartbeatFrame = { type: 'heartbeat'; seq: number };
export type ReplyFrame = { type: 'reply'; id: string; hireId: string; epoch: number; text: string };
// Best effort, no answer: the typing indicator in the conversation of inbound row inboundId.
export type TypingFrame = { type: 'typing'; hireId: string; epoch: number; inboundId: string };
// Live only, never through the outbox, never answered.
export type LeaseRevokedFrame = { type: 'lease_revoked'; hireId: string; epoch: number };
// One chunk of one file. name, size, sha256 and tainted are on index 0 only, with the target as for send.
export type FileFrame = {
  type: 'file';
  id: string;
  hireId: string;
  epoch: number;
  index: number;
  final: boolean;
  data: string;
  name?: string;
  size?: number;
  sha256?: string;
  inboundId?: string;
  recipient?: string;
  tainted?: boolean;
};
// A message to inboundId's conversation or to recipient (a Bodhi person's UPN), exactly one. From a
// tainted run, or to anyone outside the circle, the Hub raises an `outbound` card for the owner first.
export type SendFrame = { type: 'send'; id: string; hireId: string; epoch: number; text: string; tainted: boolean; inboundId?: string; recipient?: string };
export type PermissionPayload = { tool: string; summary: string };
export type SkillFile = { path: string; content: string };
export type SkillChangePayload = { baseBundle: string; files: SkillFile[] };
export type NotePatchPayload = { path: string; rev: number; baseContent: string; newContent: string };
// Raised from the target machine, which is not the hire's home: what it found for the account (§5.6).
export type MovePayload = { account: 'signed-in' | 'missing' | 'signed-out'; accountLabel: string };
export type CardRaiseFrame = {
  type: 'card_raise';
  id: string;
  hireId: string;
  epoch: number;
  kind: MachineCardKind;
  inboundId?: string;
  tainted: boolean;
  payload: PermissionPayload | SkillChangePayload | NotePatchPayload | MovePayload;
};
export type UsageWindow = { name: string; utilization: number; resetsAt: number; status: string };
export type UsageRecordFrame = {
  type: 'usage_record';
  id: string;
  hireId: string;
  epoch: number;
  runId: string;
  requestedBy: string;
  accountUuid: string;
  startedAt: number;
  durationMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  windows: UsageWindow[];
  windowsReadAt: number;
};
// The hire's totals since `since` (the day's start in the owner's timezone, or 7 days back).
export type UsageReadFrame = { type: 'usage_read'; id: string; hireId: string; epoch: number; since: number };
// Every change since global sequence `since`; `fetch` asks for the bodies of note and skill_bundle objects.
export type SyncRef = { kind: SyncKind; objectId: string };
export type SyncPullFrame = { type: 'sync_pull'; id: string; since: number; fetch?: SyncRef[] };
export type AccountRef = { accountUuid: string; email: string; label: string };
export type HireBody = { name: string; roleId: string; skillBundleId: string; skillBundleHash: string; repos: string[]; sharedWith: string[]; accountRef: AccountRef; homeMachineId: string | null; epoch: number; state: HireState; dailyTokenCap: number | null; ownerTimezone: string | null };
export type HireFields = { name?: string; roleId?: string; repos?: string[]; accountRef?: AccountRef; dailyTokenCap?: number | null };
export type RoutineBody = { hireId: string; cron: string; timezone: string; prompt: string; lastFired: number | null; lastRun: number | null };
export type RoutineFields = { cron?: string; timezone?: string; prompt?: string };
export const NOTE_SCOPES = ['owner', 'shared'] as const;
export type NoteScope = (typeof NOTE_SCOPES)[number];
export type NoteBody = { hireId: string; scope: NoteScope; path: string; content: string };
export type RoleBody = { role: string; roleMd: string; skillBundle: string };
export type SkillBundleBody = { role: string; files: SkillFile[]; hash: string };
export type EditFrame = {
  type: 'edit';
  id: string;
  op: EditOp;
  kind: EditKind;
  objectId?: string;
  rev?: number;
  hireId?: string;
  epoch?: number;
  fields: Record<string, unknown>;
};
export type NoteWriteFrame = {
  type: 'note_write';
  id: string;
  hireId: string;
  epoch: number;
  scope: RunScope;
  inboundId?: string;
  path: string;
  rev: number;
  content: string;
  deleted: boolean;
};
export type RoutineFiredFrame = {
  type: 'routine_fired';
  id: string;
  hireId: string;
  epoch: number;
  routineId: string;
  dueAt: number;
  startedAt: number;
};
export type TokenRequestFrame = {
  type: 'token_request';
  id: string;
  hireId: string;
  epoch: number;
  requestedBy: string;
  repos: string[];
};
// Local audit shipped to the Hub. Event `hold` with detail.state reports an automatic hold or its release.
export type AuditFrame = {
  type: 'audit';
  id: string;
  hireId?: string;
  epoch?: number;
  event: string;
  at: number;
  detail: Record<string, unknown>;
};
// Unlink this machine or another of the owner's.
export type UnlinkFrame = { type: 'unlink'; id: string; machineId: string };
export type ArtifactRequestFrame = { type: 'artifact_request'; id: string; name: string };

export type MachineFrame =
  | AuthFrame
  | AckFrame
  | HeartbeatFrame
  | ReplyFrame
  | TypingFrame
  | LeaseRevokedFrame
  | FileFrame
  | SendFrame
  | CardRaiseFrame
  | UsageRecordFrame
  | UsageReadFrame
  | SyncPullFrame
  | EditFrame
  | NoteWriteFrame
  | RoutineFiredFrame
  | TokenRequestFrame
  | AuditFrame
  | UnlinkFrame
  | ArtifactRequestFrame;

// ---- Hub -> machine frames -----------------------------------------------------------------------

export type ChallengeFrame = { type: 'challenge'; version: number; nonce: string; hubTime: number };
export type WelcomeFrame = { type: 'welcome'; machineId: string; hubTime: number; ownerName: string; ownerUpn: string };
export type DeliverFrame = {
  type: 'deliver';
  id: string;
  hireId: string;
  epoch: number;
  scope: RunScope;
  requestedBy: string;
  text: string;
  from: string;
};
export type Lease = { hireId: string; epoch: number };
export type RenewFrame = { type: 'renew'; seq: number; hubTime: number; leases: Lease[] };
export type RefusedFrame = { type: 'refused'; id: string; reason: RefusedReason };
export type LeaseRevokeFrame = { type: 'lease_revoke'; hireId: string; mode: LeaseMode };
export type ErrorFrame = { type: 'error'; reason: ErrorReason };
// Something changed for this machine's owner: pull from your last sequence.
export type ChangeFrame = { type: 'change'; seq: number };
// One object as synced. body is absent on a header for note and skill_bundle until fetched.
export type SyncObject = {
  kind: SyncKind;
  objectId: string;
  rev: number;
  seq: number;
  hash: string;
  deleted: boolean;
  body?: Record<string, unknown>;
};
export type SyncPageFrame = { type: 'sync_page'; id: string; changes: SyncObject[]; next: number; more: boolean };
export type EditResultFrame = {
  type: 'edit_result';
  id: string;
  result: EditResult;
  objectId?: string;
  rev?: number;
  why?: string;
  current?: SyncObject;
};
// A decision on a card this machine raised (raiseId), delivered as a job; the machine acks it by id.
export type CardDecisionFrame = {
  type: 'card_decision';
  id: string;
  hireId: string;
  epoch: number;
  raiseId: string;
  decision: CardDecision;
  decidedBy: string;
};
export type UsageFrame = {
  type: 'usage';
  id: string;
  hireId: string;
  since: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  records: number;
};
export type TokenFrame = { type: 'token'; id: string; token: string; expiresAt: number; repos: string[] };
export type ArtifactFrame = { type: 'artifact'; id: string; name: string; url: string; expiresAt: number };

export type HubFrame =
  | ChallengeFrame
  | WelcomeFrame
  | DeliverFrame
  | AckFrame
  | RenewFrame
  | RefusedFrame
  | LeaseRevokeFrame
  | ErrorFrame
  | ChangeFrame
  | SyncPageFrame
  | EditResultFrame
  | CardDecisionFrame
  | UsageFrame
  | TokenFrame
  | ArtifactFrame;

// ---- parsing -------------------------------------------------------------------------------------

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Check = (v: unknown) => boolean;
const uuid: Check = v => typeof v === 'string' && UUID_V4.test(v);
const int: Check = v => Number.isSafeInteger(v) && (v as number) >= 0;
const bool: Check = v => typeof v === 'boolean';
const text = (max: number): Check => v => typeof v === 'string' && v.length <= max;
const nonEmpty = (max: number): Check => v => typeof v === 'string' && v.length > 0 && v.length <= max;
const oneOf = (set: readonly string[]): Check => v => typeof v === 'string' && set.includes(v);
const record: Check = v => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (each: Check, max: number): Check => v => Array.isArray(v) && v.length <= max && v.every(each);
const shape = (spec: Spec): Check => v => record(v) && fits(v as Record<string, unknown>, spec);
const b64 = (maxChars: number): Check => v => typeof v === 'string' && v.length <= maxChars && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0;
const sha256Hex: Check = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const isRepo: Check = v => repo(v);
const repo: Check = v => typeof v === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(v);

// A key spec: the check, and whether the key may be absent.
type Spec = Record<string, [Check, boolean?]>;

function fits(v: Record<string, unknown>, spec: Spec): boolean {
  for (const k of Object.keys(v)) if (!(k in spec)) return false;
  for (const [k, [check, optional]] of Object.entries(spec)) {
    if (v[k] === undefined) {
      if (!optional) return false;
    } else if (!check(v[k])) return false;
  }
  return true;
}

const OPT = true;
const hireFrame: Spec = { hireId: [uuid], epoch: [int] };

const PAYLOADS: Record<MachineCardKind, Spec> = {
  permission: { tool: [nonEmpty(200)], summary: [text(4000)] },
  skill_change: { baseBundle: [sha256Hex], files: [list(shape({ path: [nonEmpty(300)], content: [text(MAX_SKILL_BYTES)] }), 500)] },
  note_patch: { path: [nonEmpty(300)], rev: [int], baseContent: [text(100_000)], newContent: [text(100_000)] },
  move: { account: [oneOf(['signed-in', 'missing', 'signed-out'])], accountLabel: [text(200)] },
};

const SPECS: Record<MachineFrameType, Spec> = {
  auth: { type: [bool], version: [int], machineId: [nonEmpty(64)], sig: [nonEmpty(200)] },
  ack: { type: [bool], id: [uuid] },
  heartbeat: { type: [bool], seq: [int] },
  reply: { type: [bool], id: [uuid], ...hireFrame, text: [text(MAX_TEXT)] },
  typing: { type: [bool], ...hireFrame, inboundId: [uuid] },
  lease_revoked: { type: [bool], ...hireFrame },
  file: {
    type: [bool],
    id: [uuid],
    ...hireFrame,
    index: [int],
    final: [bool],
    data: [b64(Math.ceil(FILE_CHUNK_BYTES / 3) * 4)],
    name: [nonEmpty(255), OPT],
    size: [int, OPT],
    sha256: [sha256Hex, OPT],
    inboundId: [uuid, OPT],
    recipient: [nonEmpty(320), OPT],
    tainted: [bool, OPT],
  },
  send: { type: [bool], id: [uuid], ...hireFrame, text: [nonEmpty(MAX_TEXT)], tainted: [bool], inboundId: [uuid, OPT], recipient: [nonEmpty(320), OPT] },
  card_raise: {
    type: [bool],
    id: [uuid],
    ...hireFrame,
    kind: [oneOf(MACHINE_CARD_KINDS)],
    inboundId: [uuid, OPT],
    tainted: [bool],
    payload: [record],
  },
  usage_record: {
    type: [bool],
    id: [uuid],
    ...hireFrame,
    runId: [uuid],
    requestedBy: [uuid],
    accountUuid: [nonEmpty(64)],
    startedAt: [int],
    durationMs: [int],
    model: [nonEmpty(100)],
    inputTokens: [int],
    outputTokens: [int],
    cacheCreationTokens: [int],
    cacheReadTokens: [int],
    windows: [list(shape({ name: [nonEmpty(40)], utilization: [v => typeof v === 'number' && v >= 0 && v <= 1], resetsAt: [int], status: [nonEmpty(40)] }), 10)],
    windowsReadAt: [int],
  },
  usage_read: { type: [bool], id: [uuid], ...hireFrame, since: [int] },
  sync_pull: { type: [bool], id: [uuid], since: [int], fetch: [list(shape({ kind: [oneOf(SYNC_KINDS)], objectId: [nonEmpty(64)] }), 200), OPT] },
  edit: {
    type: [bool],
    id: [uuid],
    op: [oneOf(EDIT_OPS)],
    kind: [oneOf(EDIT_KINDS)],
    objectId: [nonEmpty(64), OPT],
    rev: [int, OPT],
    hireId: [uuid, OPT],
    epoch: [int, OPT],
    fields: [record],
  },
  note_write: {
    type: [bool],
    id: [uuid],
    ...hireFrame,
    scope: [oneOf(RUN_SCOPES)],
    inboundId: [uuid, OPT],
    path: [nonEmpty(300)],
    rev: [int],
    content: [text(100_000)],
    deleted: [bool],
  },
  routine_fired: { type: [bool], id: [uuid], ...hireFrame, routineId: [uuid], dueAt: [int], startedAt: [int] },
  token_request: { type: [bool], id: [uuid], ...hireFrame, requestedBy: [uuid], repos: [list(repo, 50)] },
  audit: { type: [bool], id: [uuid], hireId: [uuid, OPT], epoch: [int, OPT], event: [nonEmpty(64)], at: [int], detail: [record] },
  unlink: { type: [bool], id: [uuid], machineId: [uuid] },
  artifact_request: { type: [bool], id: [uuid], name: [nonEmpty(200)] },
};
// `type` is checked by the switch, not by the spec.
for (const spec of Object.values(SPECS)) spec.type = [v => typeof v === 'string'];

export type Parsed =
  | { ok: true; frame: MachineFrame }
  | { ok: false; bad: 'unreadable' }
  | { ok: false; bad: 'unknown-type'; frameType: string }
  | { ok: false; bad: 'malformed'; frameType: MachineFrameType; id?: string };

const isMachineType = (t: unknown): t is MachineFrameType =>
  typeof t === 'string' && (MACHINE_FRAME_TYPES as readonly string[]).includes(t);

// Anything that doesn't match a frame exactly is refused, never coerced. Extra keys fail.
export function parseMachineFrame(raw: string): Parsed {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, bad: 'unreadable' };
  }
  if (!record(v)) return { ok: false, bad: 'unreadable' };
  const o = v as Record<string, unknown>;
  if (!isMachineType(o.type)) {
    return typeof o.type === 'string' ? { ok: false, bad: 'unknown-type', frameType: o.type.slice(0, 64) } : { ok: false, bad: 'unreadable' };
  }
  const id = uuid(o.id) ? (o.id as string) : undefined;
  const malformed = { ok: false as const, bad: 'malformed' as const, frameType: o.type, id };
  if (hasNul(o)) return malformed;
  if (!fits(o, SPECS[o.type])) return malformed;
  if (o.type === 'card_raise' && !fits(o.payload as Record<string, unknown>, PAYLOADS[o.kind as MachineCardKind])) return malformed;
  if (o.type === 'file' && !fileChunkFits(o)) return malformed;
  if (o.type === 'send' && [o.inboundId, o.recipient].filter(t => t !== undefined).length !== 1) return malformed;
  if (o.type === 'edit' && o.op !== 'create' && (o.objectId === undefined || o.rev === undefined)) return malformed;
  return { ok: true, frame: o as unknown as MachineFrame };
}

// Postgres stores neither a NUL nor a lone UTF-16 surrogate in text or jsonb, so a frame carrying
// one, in any key or string, could never be written: it is refused malformed, not failed on every resend.
const unstorable = (s: string) => s.includes('\0') || !s.isWellFormed();
function hasNul(v: unknown): boolean {
  if (typeof v === 'string') return unstorable(v);
  if (Array.isArray(v)) return v.some(hasNul);
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => unstorable(k) || hasNul(x));
  return false;
}

// index 0 carries name, size, sha256, tainted and exactly one target; later chunks carry none of them.
function fileChunkFits(o: Record<string, unknown>): boolean {
  const head = ['name', 'size', 'sha256', 'tainted'].map(k => o[k] !== undefined);
  const targets = [o.inboundId, o.recipient].filter(t => t !== undefined).length;
  if (o.index === 0) return head.every(Boolean) && targets === 1 && (o.size as number) <= FILE_MAX_BYTES;
  return !head.some(Boolean) && targets === 0;
}

/** A machine frame before the outbox stamps it with its hire and epoch. */
export type Unstamped<F> = Omit<F, 'type' | 'hireId' | 'epoch'>;
