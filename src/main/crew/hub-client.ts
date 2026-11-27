/**
 * The one WebSocket to the Crew Hub, signed with the relay's machine key. A
 * bad-auth after the key changed offers Link again; nothing here clears the key.
 */
import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import log from 'electron-log';
import { writeAudit } from './audit';
import { EpochFence } from './epoch';
import { LeaseClock, systemClocks, type Clocks } from './lease';
import { LocalOutbox } from './local-outbox';
import { assertSendable, cutText, isErrorReason, parseHubFrame, trimTrailingSlashes } from './protocol-parse';
import {
  HEARTBEAT_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  authMessage,
  type AuthFrame,
  type ChallengeFrame,
  type DeliverFrame,
  type ErrorReason,
  type HubFrame,
  type LeaseRevokeFrame,
  type LeaseRevokedFrame,
  type MachineFrame,
  type RefusedFrame,
  type RenewFrame,
  type ReplyFrame,
  type WelcomeFrame,
} from './protocol';

export const HUB_URL_PRODUCTION = 'https://crew.bodhi.software';
export const HUB_URL_DEVELOPMENT = 'https://crew-dev.bodhi.software';
export const HUB_URL_PREF = 'crew.hubUrl';
export const MACHINE_ID_PREF = 'crew.machineId';

/** Packaged builds on either channel use production; `crew.hubUrl` overrides. */
export function resolveHubUrl(isPackaged: boolean, override: string | null): string {
  const trimmed = override?.trim();
  if (trimmed) return trimTrailingSlashes(trimmed);
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
  private readonly clocks: Clocks;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly hubHost: string;

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
    this.hubHost = new URL(deps.hubUrl).host;
    this.lease = new LeaseClock(this.clocks);
    this.fence = new EpochFence(deps.db);
    this.outbox = new LocalOutbox(deps.db, this.fence, this.random);
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
    this.outbox.prune();
    this.sweepTimer = this.timers.setInterval(() => this.sweep(), 1000);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.timers.clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.socket?.close(1000);
    this.socket = null;
    this.lease.onConnectionClosed();
    this.outbox.onConnectionClosed();
    this.heartbeatSentAt.clear();
  }

  /** powerMonitor `resume`: every lease lapses until a heartbeat sent after the wake is renewed. */
  onResume(): void {
    this.lease.onResume();
    this.heartbeatSentAt.clear();
    this.sweep();
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
      socket = this.deps.connect(`wss://${this.hubHost}/ws`, { maxPayload: MAX_FRAME_BYTES });
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

  private onMessage(raw: string): void {
    const parsed = parseHubFrame(raw);
    if (!parsed.ok) {
      const key = parsed.type ?? parsed.problem;
      log.warn(`[Crew] dropped a Hub frame: ${parsed.problem}`, parsed.type ?? '');
      if (!this.auditedTypes.has(key)) {
        this.auditedTypes.add(key);
        writeAudit(this.deps.db, null, 'hub-frame-dropped', { problem: parsed.problem, type: parsed.type ?? null });
      }
      if (this.phase !== 'open' && (parsed.type === 'challenge' || parsed.type === 'welcome')) this.socket?.close(1000);
      return;
    }
    try {
      this.handle(parsed.frame);
    } catch (err) {
      log.error('[Crew] a Hub frame handler threw', err);
      writeAudit(this.deps.db, null, 'hub-frame-handler-error', { type: parsed.frame.type });
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
      case 'artifact':
        this.emit('artifact', frame);
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
    this.outbox.drain(this.sender, this.clocks.wall());
    this.heartbeat();
    this.heartbeatTimer = this.timers.setInterval(() => this.heartbeat(), HEARTBEAT_MS);
  }

  private heartbeat(): void {
    const seq = this.lease.sendHeartbeat();
    const sentAt = this.send({ type: 'heartbeat', seq });
    this.heartbeatSentAt.set(seq, sentAt);
    this.outbox.tick(this.sender, this.clocks.wall());
  }

  private onDeliver(frame: DeliverFrame): void {
    const before = this.fence.known(frame.hireId);
    const outcome = this.fence.recordDelivery(frame);
    if (before !== null && frame.epoch > before) this.onNewerEpoch(frame.hireId, frame.epoch, before);
    this.send({ type: 'ack', id: frame.id });
    if (outcome !== 'duplicate') this.emit('job', { id: frame.id, hireId: frame.hireId, outcome });
  }

  /** The fence has already dropped the older jobs; a run for one of them must not finish. */
  private onNewerEpoch(hireId: string, epoch: number, before: number | null): void {
    if (before !== null) this.deps.interruptRun(hireId);
    this.emit('epoch', { hireId, epoch });
  }

  private onAck(id: string): void {
    if (!this.outbox.onAck(id)) log.info(`[Crew] ack for ${id} matched no outbox item`);
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
    if (!result) {
      this.emit('refused', frame);
      return;
    }
    if (result.action === 'sync' && !this.syncRequested) {
      this.syncRequested = true;
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
        writeAudit(this.deps.db, hireId, 'lease-revoke-unknown-mode', { mode: frame.mode });
      }
      this.fence.requeueRunning(hireId);
    }
    const answer: LeaseRevokedFrame = { type: 'lease_revoked', hireId, epoch };
    this.send(answer);
    this.emit('revoked', { hireId, mode: frame.mode });
  }

  /** Queue a run's reply, cut to MAX_TEXT and stamped with its job's epoch. False when fenced. */
  sendReply(jobId: string, text: string): boolean {
    const stamp = this.fence.stampFor(jobId);
    if (!stamp) return false;
    const frame: ReplyFrame = { type: 'reply', id: jobId, hireId: stamp.hireId, epoch: stamp.epoch, text: cutText(text) };
    this.outbox.enqueue(frame, { hireId: stamp.hireId, epoch: stamp.epoch, jobId });
    if (this.phase === 'open') this.outbox.sendNow(jobId, this.sender, this.clocks.wall());
    return true;
  }

  private sweep(): void {
    for (const hireId of this.lease.sweep()) {
      this.deps.interruptRun(hireId);
      this.fence.requeueRunning(hireId);
      this.emit('lapsed', hireId);
    }
  }

  private onClose(code: number): void {
    this.socket = null;
    this.clearTimers();
    this.lease.onConnectionClosed();
    this.outbox.onConnectionClosed();
    this.heartbeatSentAt.clear();
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

  private unlinked(): void {
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
    this.deps.forgetMachineId();
    this.stopReconnecting('unlinked');
  }

  private stopReconnecting(status: HubStatus): void {
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

