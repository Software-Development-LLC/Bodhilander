/**
 * The one WebSocket to the Crew Hub, signed with the relay's machine key. A
 * bad-auth after the key changed offers Link again; nothing here clears the key.
 */
import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import log from 'electron-log';
import { writeAudit } from './audit';
import { dropRefusedCard, markCardAcked, recordCardDecision, recordCardRaise } from './card-log';
import { EpochFence } from './epoch';
import { LeaseClock, systemClocks, type Clocks } from './lease';
import { LocalOutbox } from './local-outbox';
import { applyNoteResult } from './notes';
import { assertSendable, cutText, isErrorReason, parseHubFrame, trimTrailingSlashes } from './protocol-parse';
import { CrewSync, type EditInput } from './sync';
import {
  HEARTBEAT_MS,
  MAX_FRAME_BYTES,
  OFFLINE_AFTER_MS,
  PROTOCOL_VERSION,
  authMessage,
  type AuditFrame,
  type AuthFrame,
  type CardDecisionFrame,
  type CardRaiseFrame,
  type SendFrame,
  type UsageFrame,
  type UsageReadFrame,
  type ChallengeFrame,
  type DeliverFrame,
  type EditResultFrame,
  type ErrorReason,
  type HubFrame,
  type LeaseRevokeFrame,
  type LeaseRevokedFrame,
  type MachineFrame,
  type RefusedFrame,
  type NoteWriteFrame,
  type RenewFrame,
  type RoutineFiredFrame,
  type ReplyFrame,
  type SyncPageFrame,
  type SyncPullFrame,
  type TokenRequestFrame,
  type MovePayload,
  type Unstamped,
  type UsageRecordFrame,
  type WelcomeFrame,
} from './protocol';

export type UsageInput = Omit<UsageRecordFrame, 'type' | 'id' | 'hireId' | 'epoch'>;

export const HUB_URL_PRODUCTION = 'https://crew.bodhi.software';
export const HUB_URL_DEVELOPMENT = 'https://crew-dev.bodhi.software';
export const HUB_URL_PREF = 'crew.hubUrl';
export const MACHINE_ID_PREF = 'crew.machineId';

/** A v4-shaped uuid fixed by its seed, so a re-send keeps the id the Hub dedups on. */
export function derivedUuid(seed: string): string {
  const b = createHash('sha256').update(seed).digest();
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Plain http, and so plain ws, only for a Hub on this machine. */
export function isLoopbackHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

function isHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname !== '';
  } catch {
    return false;
  }
}

/** Packaged builds on either channel use production; `crew.hubUrl` overrides with https, or http on loopback. */
export function resolveHubUrl(isPackaged: boolean, override: string | null): string {
  const trimmed = override?.trim();
  if (trimmed && (isHttps(trimmed) || isLoopbackHttp(trimmed))) return trimTrailingSlashes(trimmed);
  if (trimmed) log.warn('[Crew] ignored crew.hubUrl: it must be https, or http on this machine');
  return isPackaged ? HUB_URL_PRODUCTION : HUB_URL_DEVELOPMENT;
}

export const CLOSE_CODES: Record<number, ErrorReason> = {
  4426: 'protocol-version',
  4401: 'bad-auth',
  4403: 'pending',
  4410: 'unlinked',
  4408: 'auth-timeout',
  4409: 'replaced',
};

export const BACKOFF_FIRST_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;
export const SKEW_LIMIT_MS = 2 * 60_000;
export const USAGE_READ_TIMEOUT_MS = 10_000;
/** Heartbeats left unrenewed before the socket is treated as dead: the Hub's own offline window. */
export const MISSED_RENEWS_LIMIT = OFFLINE_AFTER_MS / HEARTBEAT_MS;

export type HubStatus =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'pending'
  | 'unavailable'
  | 'update-required'
  | 'link-again'
  | 'unlinked'
  | 'key-unavailable'
  | 'replaced';

/** The subset of `ws`'s WebSocket this client uses. */
export interface HubSocket {
  send(data: string): void;
  close(code?: number): void;
  terminate(): void;
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: unknown) => void): unknown;
  on(event: 'close', cb: (code: number) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface HubClientDeps {
  db: Database.Database;
  hubUrl: string;
  getMachineId(): string | null;
  forgetMachineId(): void;
  sign(message: Uint8Array): Buffer;
  connect(url: string, options: { maxPayload: number }): HubSocket;
  /** Interrupt the hire's running run, if any. The run loop arrives with the runs part. */
  interruptRun(hireId: string): void;
  clocks?: Clocks;
  timers?: Timers;
  random?: () => number;
  newId?: () => string;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

type Phase = 'challenge' | 'welcome' | 'open';

export class HubClient extends EventEmitter {
  readonly lease: LeaseClock;
  readonly fence: EpochFence;
  readonly outbox: LocalOutbox;
  readonly sync: CrewSync;
  private readonly clocks: Clocks;
  private readonly usageWaiters = new Map<string, (frame: UsageFrame | null) => void>();
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly hubHost: string;
  private readonly wsPath: string;
  private readonly wsScheme: 'ws' | 'wss';
  private readonly newId: () => string;

  private socket: HubSocket | null = null;
  private phase: Phase = 'challenge';
  private status: HubStatus = 'idle';
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private sweepTimer: unknown = null;
  private errorReason: string | null = null;
  private sendIndex = 0;
  private readonly heartbeatSentAt = new Map<number, number>();
  private pullSentAt: number | null = null;
  private readonly auditedTypes = new Set<string>();
  private syncRequested = false;
  private skewMs = 0;
  private ownerName: string | null = null;
  private ownerUpn: string | null = null;

  constructor(private readonly deps: HubClientDeps) {
    super();
    this.clocks = deps.clocks ?? systemClocks;
    this.timers = deps.timers ?? realTimers;
    this.random = deps.random ?? Math.random;
    const url = new URL(deps.hubUrl);
    this.hubHost = url.host;
    this.wsPath = `${trimTrailingSlashes(url.pathname)}/ws`;
    this.wsScheme = isLoopbackHttp(deps.hubUrl) ? 'ws' : 'wss';
    this.lease = new LeaseClock(this.clocks);
    this.fence = new EpochFence(deps.db);
    this.outbox = new LocalOutbox(deps.db, this.fence, this.random);
    this.newId = deps.newId ?? randomUUID;
    this.sync = new CrewSync(deps.db, this.newId);
  }

  get hubUrl(): string {
    return this.deps.hubUrl;
  }

  getStatus(): HubStatus {
    return this.status;
  }

  owner(): { name: string; upn: string } | null {
    return this.ownerName === null ? null : { name: this.ownerName, upn: this.ownerUpn ?? '' };
  }

  /** Signed Hub minus local wall time, from the latest challenge or renew. */
  clockSkewMs(): number {
    return this.skewMs;
  }

  /** Routines hold while the clock is more than 2 minutes off the Hub's. */
  routinesHeldForSkew(): boolean {
    return Math.abs(this.skewMs) > SKEW_LIMIT_MS;
  }

  start(): void {
    if (!this.stopped) return;
    if (!this.deps.getMachineId()) return;
    this.stopped = false;
    this.guarded('prune', () => this.outbox.prune());
    this.sweepTimer = this.timers.setInterval(() => this.guarded('sweep', () => this.sweep()), 1000);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.timers.clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.socket?.close(1000);
    this.socket = null;
    this.releaseLeases();
    this.connectionClosed();
  }

  private connectionClosed(): void {
    this.phase = 'challenge';
    for (const settle of [...this.usageWaiters.values()]) settle(null);
    this.lease.onConnectionClosed();
    this.outbox.onConnectionClosed();
    this.sync.onClosed();
    this.heartbeatSentAt.clear();
    this.pullSentAt = null;
  }

  /** powerMonitor `resume`: every lease lapses until a heartbeat sent after the wake is renewed. */
  onResume(): void {
    this.guarded('resume', () => {
      this.lease.onResume();
      this.heartbeatSentAt.clear();
      this.sweep();
      if (this.phase === 'open') this.heartbeat();
    });
  }

  canStart(hireId: string, epoch: number): boolean {
    return this.lease.held(hireId, epoch);
  }

  private setStatus(status: HubStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  private open(): void {
    const machineId = this.deps.getMachineId();
    if (!machineId) {
      this.stopped = true;
      this.setStatus('unlinked');
      return;
    }
    this.phase = 'challenge';
    this.errorReason = null;
    this.sendIndex = 0;
    this.syncRequested = false;
    this.auditedTypes.clear();
    this.setStatus(this.status === 'pending' ? 'pending' : 'connecting');
    let socket: HubSocket;
    try {
      socket = this.deps.connect(`${this.wsScheme}://${this.hubHost}${this.wsPath}`, { maxPayload: MAX_FRAME_BYTES });
    } catch (err) {
      log.warn('[Crew] could not open the Hub socket', err);
      this.scheduleReconnect('unavailable');
      return;
    }
    this.socket = socket;
    socket.on('message', (data) => {
      if (this.socket === socket) this.onMessage(String(data));
    });
    socket.on('close', (code) => {
      if (this.socket === socket) this.onClose(code);
    });
    socket.on('error', (err) => log.warn('[Crew] Hub socket error', err.message));
  }

  private readonly sender = {
    send: (text: string): number => {
      this.socket?.send(text);
      this.sendIndex += 1;
      return this.sendIndex;
    },
  };

  private send(frame: MachineFrame): number {
    return this.sender.send(assertSendable(frame));
  }

  /** A timer callback that throws is logged and audited, never left to crash the main process. */
  private guarded(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error(`[Crew] the ${what} timer threw`, err);
      this.audit('hub-timer-error', { timer: what });
    }
  }

  /** An audit row that cannot be written leaves the log line as the only record. */
  private audit(event: string, detail: Record<string, unknown>): void {
    try {
      writeAudit(this.deps.db, null, event, detail);
    } catch (err) {
      log.error(`[Crew] could not audit ${event}`, err);
    }
  }

  private onMessage(raw: string): void {
    const parsed = parseHubFrame(raw);
    if (!parsed.ok) {
      const key = parsed.type ?? parsed.problem;
      log.warn(`[Crew] dropped a Hub frame: ${parsed.problem}`, parsed.type ?? '');
      if (!this.auditedTypes.has(key)) {
        this.auditedTypes.add(key);
        this.audit('hub-frame-dropped', { problem: parsed.problem, type: parsed.type ?? null });
      }
      if (this.phase !== 'open' && (parsed.type === 'challenge' || parsed.type === 'welcome')) this.socket?.close(1000);
      return;
    }
    try {
      this.handle(parsed.frame);
    } catch (err) {
      log.error('[Crew] a Hub frame handler threw', err);
      this.audit('hub-frame-handler-error', { type: parsed.frame.type });
    }
  }

  private handle(frame: HubFrame): void {
    if (frame.type === 'error') {
      this.errorReason = frame.reason;
      return;
    }
    if (this.phase === 'challenge') {
      if (frame.type === 'challenge') this.onChallenge(frame);
      else this.socket?.close(1000);
      return;
    }
    if (this.phase === 'welcome') {
      if (frame.type === 'welcome') this.onWelcome(frame);
      else this.socket?.close(1000);
      return;
    }
    switch (frame.type) {
      case 'deliver':
        return this.onDeliver(frame);
      case 'ack':
        return this.onAck(frame.id);
      case 'renew':
        return this.onRenew(frame);
      case 'refused':
        return this.onRefused(frame);
      case 'lease_revoke':
        return this.onLeaseRevoke(frame);
      case 'change':
        return this.sendPull(this.sync.onChange(frame.seq, this.clocks.wall()));
      case 'sync_page':
        return this.onSyncPage(frame);
      case 'edit_result':
        return this.onEditResult(frame);
      case 'artifact':
        this.emit('artifact', frame);
        return;
      case 'card_decision':
        return this.onCardDecision(frame);
      case 'usage':
        this.usageWaiters.get(frame.id)?.(frame);
        return;
      case 'token':
        this.emit('token', frame);
        return;
      default:
        log.warn(`[Crew] ignored a ${frame.type} frame after welcome`);
    }
  }

  private onChallenge(frame: ChallengeFrame): void {
    if (frame.version !== PROTOCOL_VERSION) {
      this.stopReconnecting('update-required');
      this.socket?.close(1000);
      return;
    }
    this.skewMs = frame.hubTime - this.clocks.wall();
    const machineId = this.deps.getMachineId();
    let sig: string;
    try {
      if (!machineId) throw new Error('no machine id');
      sig = this.deps.sign(new TextEncoder().encode(authMessage(this.hubHost, machineId, frame.nonce))).toString('base64');
    } catch (err) {
      log.warn('[Crew] could not sign the Hub challenge', err);
      this.stopReconnecting('key-unavailable');
      this.socket?.close(1000);
      return;
    }
    const auth: AuthFrame = { type: 'auth', version: PROTOCOL_VERSION, machineId, sig };
    this.send(auth);
    this.phase = 'welcome';
  }

  private onWelcome(frame: WelcomeFrame): void {
    if (frame.machineId !== this.deps.getMachineId()) {
      this.stopReconnecting('link-again');
      this.socket?.close(1000);
      return;
    }
    this.phase = 'open';
    this.attempt = 0;
    this.skewMs = frame.hubTime - this.clocks.wall();
    this.ownerName = frame.ownerName;
    this.ownerUpn = frame.ownerUpn;
    this.setStatus('online');
    this.emit('welcome', frame);
    this.guarded('drain', () => this.outbox.drain(this.sender, this.clocks.wall()));
    this.guarded('pull', () => this.sendPull(this.sync.onConnect(this.clocks.wall())));
    this.guarded('heartbeat', () => this.heartbeat());
    this.heartbeatTimer = this.timers.setInterval(() => this.guarded('heartbeat', () => this.heartbeat()), HEARTBEAT_MS);
  }

  private heartbeat(): void {
    if (this.heartbeatSentAt.size >= MISSED_RENEWS_LIMIT) {
      this.dropDeadSocket();
      return;
    }
    const seq = this.lease.sendHeartbeat();
    const sentAt = this.send({ type: 'heartbeat', seq });
    this.heartbeatSentAt.set(seq, sentAt);
    this.outbox.tick(this.sender, this.clocks.wall());
    this.sendPull(this.sync.resend(this.clocks.wall()));
  }

  private sendPull(frame: SyncPullFrame | null): void {
    if (frame) this.pullSentAt = this.send(frame);
  }

  private onSyncPage(frame: SyncPageFrame): void {
    if (frame.id !== this.sync.pendingId()) {
      log.info(`[Crew] sync_page ${frame.id} matched no pull`);
      return;
    }
    if (this.pullSentAt !== null) this.outbox.noteAnswered(this.pullSentAt);
    this.pullSentAt = null;
    this.sendPull(this.sync.onPage(frame, this.clocks.wall()));
    this.emit('synced', frame.changes.length);
  }

  private onEditResult(frame: EditResultFrame): void {
    const sent = this.outbox.frameOf(frame.id);
    try {
      if (sent?.type === 'note_write') applyNoteResult(this.deps.db, sent, frame);
      this.sendPull(this.sync.onEditResult(frame, this.clocks.wall(), sent?.type === 'edit' ? sent : null));
    } catch (err) {
      log.warn(`[Crew] could not apply edit_result ${frame.id}; the next sync catches up`, err);
    }
    try {
      this.emit('edit-result', frame);
    } finally {
      if (!this.outbox.onAck(frame.id)) log.info(`[Crew] edit_result for ${frame.id} matched no edit`);
    }
  }

  private onDeliver(frame: DeliverFrame): void {
    const before = this.fence.known(frame.hireId);
    const outcome = this.fence.recordDelivery(frame);
    if (before !== null && frame.epoch > before) this.onNewerEpoch(frame.hireId, frame.epoch, before);
    this.send({ type: 'ack', id: frame.id });
    if (outcome !== 'duplicate') this.emit('job', { id: frame.id, hireId: frame.hireId, outcome });
  }

  /** Fenced like a delivery, and acked only once handled, so a decision that failed comes again. */
  private onCardDecision(frame: CardDecisionFrame): void {
    const before = this.fence.known(frame.hireId);
    if (before !== null && frame.epoch < before) {
      this.audit('card-decision-stale', { hireId: frame.hireId, raiseId: frame.raiseId, epoch: frame.epoch, known: before });
      this.send({ type: 'ack', id: frame.id });
      return;
    }
    if (this.fence.observe(frame.hireId, frame.epoch)) this.onNewerEpoch(frame.hireId, frame.epoch, before);
    this.emit('card-decision', frame);
    recordCardDecision(this.deps.db, frame.raiseId, frame.decision, frame.decidedBy);
    this.send({ type: 'ack', id: frame.id });
  }

  /** The fence has already dropped the older jobs; a run for one of them must not finish. */
  private onNewerEpoch(hireId: string, epoch: number, before: number | null): void {
    if (before !== null) this.deps.interruptRun(hireId);
    this.emit('epoch', { hireId, epoch });
  }

  private onAck(id: string): void {
    if (!this.outbox.onAck(id)) log.info(`[Crew] ack for ${id} matched no outbox item`);
    markCardAcked(this.deps.db, id);
  }

  private onRenew(frame: RenewFrame): void {
    this.skewMs = frame.hubTime - this.clocks.wall();
    const sentAt = this.heartbeatSentAt.get(frame.seq);
    this.heartbeatSentAt.delete(frame.seq);
    if (sentAt !== undefined) this.outbox.noteAnswered(sentAt);
    for (const { hireId, epoch } of frame.leases) {
      const before = this.fence.known(hireId);
      if (this.fence.observe(hireId, epoch)) this.onNewerEpoch(hireId, epoch, before);
    }
    const renewed = this.lease.onRenew(frame.seq, frame.leases);
    if (renewed.length > 0) this.emit('renewed', renewed);
  }

  private onRefused(frame: RefusedFrame): void {
    const result = this.outbox.onRefused(frame.id, frame.reason);
    const usageWaiter = this.usageWaiters.get(frame.id);
    if (usageWaiter) return usageWaiter(null);
    if (!result) {
      this.emit('refused', frame);
      return;
    }
    if (result.frameType === 'card_raise') {
      dropRefusedCard(this.deps.db, frame.id, frame.reason);
      this.emit('card-refused', frame.id);
    }
    if (result.action === 'sync' && !this.syncRequested) {
      this.syncRequested = true;
      this.sendPull(this.sync.request(this.clocks.wall()));
      this.emit('sync-needed');
    }
  }

  private onLeaseRevoke(frame: LeaseRevokeFrame): void {
    const { hireId } = frame;
    this.lease.revoke(hireId);
    this.deps.interruptRun(hireId);
    const epoch = this.fence.revokeEpoch(hireId);
    if (frame.mode === 'drop') {
      this.fence.dropHire(hireId);
    } else {
      if (frame.mode !== 'pause') {
        log.warn(`[Crew] lease_revoke with unknown mode for ${hireId}; treating it as pause`);
        this.audit('lease-revoke-unknown-mode', { hireId, mode: frame.mode });
      }
      this.fence.requeueRunning(hireId);
    }
    const answer: LeaseRevokedFrame = { type: 'lease_revoked', hireId, epoch };
    this.send(answer);
    this.emit('revoked', { hireId, mode: frame.mode });
  }

  /** The Hub let the hire go: this machine stops leasing it and drops its jobs, so nothing runs it again. */
  forgetHire(hireId: string): void {
    this.lease.revoke(hireId);
    this.fence.dropHire(hireId);
    this.audit('hire-let-go', { hireId });
  }

  /** Queue a run's reply, cut to MAX_TEXT and stamped with its job's epoch. False when fenced or already queued. */
  sendReply(jobId: string, text: string): boolean {
    const stamp = this.fence.stampFor(jobId);
    if (!stamp) return false;
    const frame: ReplyFrame = { type: 'reply', id: jobId, hireId: stamp.hireId, epoch: stamp.epoch, text: cutText(text) };
    return this.queue(frame, { hireId: stamp.hireId, epoch: stamp.epoch, jobId });
  }

  private queue(frame: MachineFrame & { id: string }, meta: { hireId?: string; epoch?: number; jobId?: string }): boolean {
    if (!this.outbox.enqueue(frame, meta)) return false;
    if (this.phase === 'open') this.outbox.sendNow(frame.id, this.sender, this.clocks.wall());
    return true;
  }

  /** Queue an edit against the cached rev; a hire's edit carries its newest known epoch. Returns the edit id. */
  sendEdit(input: EditInput): string {
    const epoch = input.epoch ?? (input.hireId === undefined ? undefined : (this.fence.known(input.hireId) ?? undefined));
    const frame = this.sync.buildEdit({ ...input, epoch });
    this.queue(frame, { hireId: frame.hireId, epoch: frame.epoch });
    return frame.id;
  }

  /** Queue a job's one usage record under its epoch. False when the job is gone, fenced, or its usage is already queued. */
  sendUsage(jobId: string, usage: UsageInput): boolean {
    const stamp = this.fence.stampFor(jobId);
    if (!stamp) return false;
    const frame: UsageRecordFrame = { type: 'usage_record', id: derivedUuid(`usage:${jobId}`), hireId: stamp.hireId, epoch: stamp.epoch, ...usage };
    return this.queue(frame, { hireId: stamp.hireId, epoch: stamp.epoch, jobId });
  }

  /** Queue a card raised by a job's run, stamped with the job's epoch. False when fenced or gone. */
  sendCard(jobId: string, raise: Unstamped<CardRaiseFrame>): boolean {
    const stamp = this.fence.stampFor(jobId);
    if (!stamp) return false;
    const frame: CardRaiseFrame = { type: 'card_raise', ...raise, hireId: stamp.hireId, epoch: stamp.epoch };
    const queued = this.queue(frame, { hireId: stamp.hireId, epoch: stamp.epoch, jobId });
    if (queued) recordCardRaise(this.deps.db, frame, this.clocks.wall());
    return queued;
  }

  /** Queue a run's note write, stamped with its job's epoch. False when fenced or gone. */
  sendNoteWrite(jobId: string, write: Unstamped<NoteWriteFrame>): boolean {
    const stamp = this.fence.stampFor(jobId);
    if (!stamp) return false;
    const frame: NoteWriteFrame = { type: 'note_write', ...write, hireId: stamp.hireId, epoch: stamp.epoch };
    return this.queue(frame, { hireId: stamp.hireId, epoch: stamp.epoch, jobId });
  }

  /** A move card for a hire with no home, raised from this machine at the hire's newest epoch. */
  sendMoveCard(hireId: string, payload: MovePayload): string | null {
    const epoch = this.fence.known(hireId);
    if (epoch === null) return null;
    const frame: CardRaiseFrame = { type: 'card_raise', id: this.newId(), hireId, epoch, kind: 'move', tainted: false, payload };
    if (!this.queue(frame, { hireId, epoch })) return null;
    recordCardRaise(this.deps.db, frame, this.clocks.wall());
    return frame.id;
  }

  sendUnlink(machineId: string): boolean {
    return this.queue({ type: 'unlink', id: this.newId(), machineId }, {});
  }

  /** An owner/ note written by the owner's own action on this machine, not by a run. */
  sendOwnerNote(hireId: string, notePath: string, rev: number, content: string): boolean {
    const epoch = this.fence.known(hireId);
    if (epoch === null || !notePath.startsWith('owner/')) return false;
    const frame: NoteWriteFrame = { type: 'note_write', id: this.newId(), hireId, epoch, scope: 'owner', path: notePath, rev, content, deleted: false };
    return this.queue(frame, { hireId, epoch });
  }

  /** A routine's job was queued: the Hub moves the routine's lastFired to dueAt and lastRun to startedAt. */
  sendRoutineFired(jobId: string, routineId: string, dueAt: number, startedAt: number): boolean {
    const stamp = this.fence.stampFor(jobId);
    if (!stamp) return false;
    const frame: RoutineFiredFrame = { type: 'routine_fired', id: derivedUuid(`routine-fired:${jobId}`), hireId: stamp.hireId, epoch: stamp.epoch, routineId, dueAt, startedAt };
    return this.queue(frame, { hireId: stamp.hireId, epoch: stamp.epoch, jobId });
  }

  knownEpoch(hireId: string): number | null {
    return this.fence.known(hireId);
  }

  /** Queue a run's send through the outbox, stamped with its job's epoch. False when fenced or gone. */
  sendMessage(jobId: string, send: Unstamped<SendFrame>): boolean {
    const stamp = this.fence.stampFor(jobId);
    if (!stamp) return false;
    const frame: SendFrame = { type: 'send', ...send, text: cutText(send.text), hireId: stamp.hireId, epoch: stamp.epoch };
    return this.queue(frame, { hireId: stamp.hireId, epoch: stamp.epoch, jobId });
  }

  /**
   * Ask for a read token for a job's requester; the answer arrives as a `token` or `refused` event with this id.
   * Sent only on an open connection and never queued: nobody is waiting for a token minted after a reconnect.
   */
  sendTokenRequest(jobId: string, id: string, requestedBy: string, repos: string[]): boolean {
    const stamp = this.fence.stampFor(jobId);
    if (!stamp || this.phase !== 'open') return false;
    const frame: TokenRequestFrame = { type: 'token_request', id, hireId: stamp.hireId, epoch: stamp.epoch, requestedBy, repos };
    this.send(frame);
    return true;
  }

  /** A hire's usage since `since`, asked live. Null when offline, refused, closed or unanswered in time. */
  usageRead(hireId: string, epoch: number, since: number, timeoutMs = USAGE_READ_TIMEOUT_MS): Promise<UsageFrame | null> {
    if (this.phase !== 'open') return Promise.resolve(null);
    const id = this.newId();
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => settle(null), timeoutMs);
      const settle = (frame: UsageFrame | null) => {
        this.usageWaiters.delete(id);
        this.timers.clearTimeout(timer);
        resolve(frame);
      };
      this.usageWaiters.set(id, settle);
      const frame: UsageReadFrame = { type: 'usage_read', id, hireId, epoch, since };
      this.send(frame);
    });
  }

  /** Ship a local audit entry; one about a hire carries its newest known epoch. */
  sendAudit(event: string, detail: Record<string, unknown>, hireId?: string): string {
    const frame: AuditFrame = { type: 'audit', id: this.newId(), event, at: this.clocks.wall(), detail };
    const epoch = hireId === undefined ? null : this.fence.known(hireId);
    if (hireId !== undefined) frame.hireId = hireId;
    if (epoch !== null) frame.epoch = epoch;
    this.queue(frame, { hireId, epoch: epoch ?? undefined });
    return frame.id;
  }

  private sweep(): void {
    for (const hireId of this.lease.sweep()) {
      this.deps.interruptRun(hireId);
      this.fence.requeueRunning(hireId);
      this.emit('lapsed', hireId);
    }
  }

  /** No renew for the Hub's offline window: the connection is gone even if TCP has not said so. */
  private dropDeadSocket(): void {
    log.warn('[Crew] no renew from the Hub; dropping the connection');
    this.socket?.terminate();
    this.onClose(1006);
  }

  private onClose(code: number): void {
    this.socket = null;
    this.clearTimers();
    this.connectionClosed();
    if (this.stopped) return;

    const fromFrame = this.errorReason !== null && isErrorReason(this.errorReason) ? (this.errorReason as ErrorReason) : null;
    const reason = fromFrame ?? CLOSE_CODES[code] ?? null;
    switch (reason) {
      case 'protocol-version':
        return this.stopReconnecting('update-required');
      case 'bad-auth':
        return this.stopReconnecting('link-again');
      case 'replaced':
        log.warn('[Crew] another connection replaced this one');
        return this.stopReconnecting('replaced');
      case 'unlinked':
        this.unlinked();
        return;
      case 'pending':
        return this.scheduleReconnect('pending');
      default:
        return this.scheduleReconnect('unavailable');
    }
  }

  /** Another connection holds the hires now, or none does: nothing here may keep running. */
  private releaseLeases(): void {
    for (const hireId of this.lease.revokeAll()) {
      this.deps.interruptRun(hireId);
      this.fence.requeueRunning(hireId);
    }
  }

  private unlinked(): void {
    this.releaseLeases();
    const db = this.deps.db;
    const hires = db.prepare(`SELECT DISTINCT hire_id FROM crew_job WHERE state IN ('queued', 'running', 'parked')`).all() as {
      hire_id: string;
    }[];
    for (const { hire_id } of hires) this.deps.interruptRun(hire_id);
    db.transaction(() => {
      db.prepare(`UPDATE crew_job SET state = 'dropped', updated_at = CURRENT_TIMESTAMP WHERE state IN ('queued', 'running', 'parked')`).run();
      this.outbox.dropAll();
      for (const table of ['crew_hire_cache', 'crew_role_cache', 'crew_skill_cache', 'crew_routine_cache', 'crew_note', 'crew_sync_state']) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      writeAudit(db, null, 'unlinked', {});
    })();
    this.sync.forget();
    this.deps.forgetMachineId();
    this.stopReconnecting('unlinked');
  }

  private stopReconnecting(status: HubStatus): void {
    this.releaseLeases();
    this.stopped = true;
    this.clearTimers();
    this.timers.clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.setStatus(status);
  }

  /** 1 s doubling to 30 s, up to 20% jitter below that, reset by welcome. */
  backoffMs(attempt: number): number {
    const base = Math.min(BACKOFF_FIRST_MS * 2 ** attempt, BACKOFF_CAP_MS);
    return base - base * 0.2 * this.random();
  }

  private scheduleReconnect(status: HubStatus): void {
    this.setStatus(status);
    const delay = this.backoffMs(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer !== null) this.timers.clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }
}

