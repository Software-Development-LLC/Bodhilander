/**
 * Each hire's 5-minute lease, counted from the SEND of the heartbeat the Hub
 * renewed, on both the monotonic and the wall clock; either passing 5 minutes
 * lapses it. A wake from sleep lapses every lease until a heartbeat sent after
 * the wake is renewed.
 */
import type { RenewLease } from './protocol';

export const LEASE_MS = 5 * 60 * 1000;
export const HEARTBEAT_MS = 30 * 1000;

export interface Clocks {
  /** Milliseconds on a clock a wall-clock change cannot move. */
  mono(): number;
  wall(): number;
}

export const systemClocks: Clocks = {
  mono: () => Number(process.hrtime.bigint() / 1_000_000n),
  wall: () => Date.now(),
};

interface Sent {
  mono: number;
  wall: number;
}

interface Held {
  epoch: number;
  mono: number;
  wall: number;
}

export class LeaseClock {
  private seq = 0;
  private readonly sent = new Map<number, Sent>();
  private readonly leases = new Map<string, Held>();
  private readonly wasHeld = new Set<string>();

  constructor(private readonly clocks: Clocks = systemClocks) {}

  /** The seq for the next heartbeat frame; its send time is recorded now. */
  sendHeartbeat(): number {
    this.seq += 1;
    this.sent.set(this.seq, { mono: this.clocks.mono(), wall: this.clocks.wall() });
    return this.seq;
  }

  /** Apply a renew; returns the hires it renewed. An unknown or pre-wake seq renews nothing. */
  onRenew(seq: number, leases: RenewLease[]): string[] {
    const hb = this.sent.get(seq);
    if (!hb) return [];
    this.sent.delete(seq);
    const renewed: string[] = [];
    for (const { hireId, epoch } of leases) {
      const current = this.leases.get(hireId);
      if (current && current.epoch === epoch && current.mono >= hb.mono) continue;
      if (current && current.epoch > epoch) continue;
      this.leases.set(hireId, { epoch, mono: hb.mono, wall: hb.wall });
      renewed.push(hireId);
    }
    return renewed;
  }

  /** Forgetting the sent heartbeats is what stops a renew for one from before the wake. */
  onResume(): void {
    this.sent.clear();
    this.leases.clear();
  }

  /** seq is per connection: a renew can never answer a heartbeat from an earlier socket. */
  onConnectionClosed(): void {
    this.sent.clear();
    this.seq = 0;
  }

  revoke(hireId: string): void {
    this.leases.delete(hireId);
  }

  held(hireId: string, epoch?: number): boolean {
    const lease = this.leases.get(hireId);
    if (!lease) return false;
    if (epoch !== undefined && lease.epoch !== epoch) return false;
    const m = this.clocks.mono() - lease.mono;
    const w = this.clocks.wall() - lease.wall;
    return m >= 0 && m < LEASE_MS && w >= 0 && w < LEASE_MS;
  }

  epochOf(hireId: string): number | null {
    return this.leases.get(hireId)?.epoch ?? null;
  }

  /** Hires whose lease was held at the last sweep and is not now. */
  sweep(): string[] {
    const lapsed: string[] = [];
    for (const hireId of this.wasHeld) {
      if (!this.held(hireId)) lapsed.push(hireId);
    }
    this.wasHeld.clear();
    for (const hireId of this.leases.keys()) {
      if (this.held(hireId)) this.wasHeld.add(hireId);
    }
    return lapsed;
  }
}
