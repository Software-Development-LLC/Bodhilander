/**
 * A verbatim copy of bodhi-service-crew's `src/protocol.ts`; the Hub owns it.
 * Copied from: the Hub's published frame contract (no Hub commit carried the
 * file yet). Re-copy from the merged Hub commit, and record its sha here.
 */

export const PROTOCOL_VERSION = 2;

/** deliver and reply text, in UTF-16 code units, the cut notice included. */
export const MAX_TEXT = 28_000;

/** Both directions, and the WebSocket's maxPayload on both ends. */
export const MAX_FRAME_BYTES = 262_144;

/** Raw bytes per `file` chunk (131,072 characters of base64). */
export const FILE_CHUNK_BYTES = 98_304;

export const FILE_MAX_BYTES = 26_214_400;

export const MACHINE_FRAME_TYPES = [
  'auth',
  'ack',
  'heartbeat',
  'reply',
  'typing',
  'lease_revoked',
  'file',
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

export const ERROR_REASONS = [
  'protocol-version',
  'bad-auth',
  'pending',
  'unlinked',
  'auth-timeout',
  'replaced',
] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number];

export const LINK_ERRORS = [
  'bad-request',
  'bad-signature',
  'clock-skew',
  'replayed',
  'already-linked',
] as const;
export type LinkError = (typeof LINK_ERRORS)[number];

export type RunScope = 'owner' | 'circle';

/** The string the machine key signs for /ws auth. No timestamp: the nonce is single use. */
export function authMessage(hubHost: string, machineId: string, nonce: string): string {
  return `bodhi-crew-hub-auth-v1:${hubHost}:${machineId}:${nonce}`;
}

/** The string the machine key signs for POST /link/codes. */
export function linkMessage(
  hubHost: string,
  ed25519Pub: string,
  x25519Pub: string,
  issuedAt: number,
  name: string,
): string {
  return ['bodhi-crew-link-v1', hubHost, ed25519Pub, x25519Pub, String(issuedAt), name].join('\n');
}

// ---- POST /link/codes ------------------------------------------------------
// hubTime, expiresAt and issuedAt are integer milliseconds since the Unix epoch.

export interface LinkCodeRequest {
  name: string;
  ed25519Pub: string;
  x25519Pub: string;
  issuedAt: number;
  sig: string;
}

export interface LinkCodeResponse {
  code: string;
  confirmCode: string;
  machineId: string;
}

export interface LinkCodeConflict {
  error: 'already-linked';
  machineId: string;
  ownerName: string;
  ownerUpn: string;
}

export interface LinkCodeError {
  error: LinkError;
  hubTime: number;
}

// ---- machine -> Hub ---------------------------------------------------------

export interface AuthFrame {
  type: 'auth';
  version: number;
  machineId: string;
  sig: string;
}

export interface AckFrame {
  type: 'ack';
  id: string;
}

export interface HeartbeatFrame {
  type: 'heartbeat';
  seq: number;
}

export interface ReplyFrame {
  type: 'reply';
  id: string;
  hireId: string;
  epoch: number;
  text: string;
}

export interface LeaseRevokedFrame {
  type: 'lease_revoked';
  hireId: string;
  epoch: number;
}

export interface FileFrame {
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
}

export interface ArtifactRequestFrame {
  type: 'artifact_request';
  id: string;
  name: string;
}

export type MachineFrame =
  | AuthFrame
  | AckFrame
  | HeartbeatFrame
  | ReplyFrame
  | LeaseRevokedFrame
  | FileFrame
  | ArtifactRequestFrame;

// ---- Hub -> machine ---------------------------------------------------------

export interface ChallengeFrame {
  type: 'challenge';
  version: number;
  nonce: string;
  hubTime: number;
}

export interface WelcomeFrame {
  type: 'welcome';
  machineId: string;
  hubTime: number;
  ownerName: string;
  ownerUpn: string;
}

export interface DeliverFrame {
  type: 'deliver';
  id: string;
  hireId: string;
  epoch: number;
  scope: RunScope;
  requestedBy: string;
  text: string;
  from: string;
}

export interface RenewLease {
  hireId: string;
  epoch: number;
}

export interface RenewFrame {
  type: 'renew';
  seq: number;
  hubTime: number;
  leases: RenewLease[];
}

export interface RefusedFrame {
  type: 'refused';
  id: string;
  reason: RefusedReason;
}

export interface LeaseRevokeFrame {
  type: 'lease_revoke';
  hireId: string;
  mode: 'drop' | 'pause';
}

export interface ErrorFrame {
  type: 'error';
  reason: ErrorReason;
}

export interface ArtifactFrame {
  type: 'artifact';
  id: string;
  name: string;
  url: string;
  expiresAt: number;
}

export type HubFrame =
  | ChallengeFrame
  | WelcomeFrame
  | DeliverFrame
  | AckFrame
  | RenewFrame
  | RefusedFrame
  | LeaseRevokeFrame
  | ErrorFrame
  | ArtifactFrame;
