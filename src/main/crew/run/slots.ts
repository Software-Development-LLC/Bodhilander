/**
 * Run slots: one chat or routine run per hire and `crew.maxRuns` per machine.
 * A queued chat beats a queued routine for the next free slot.
 */
export type SlotKind = 'chat' | 'routine';

export interface Slot {
  readonly hireId: string;
  readonly kind: SlotKind;
  release(): void;
}

export interface QueuedJob {
  id: string;
  hireId: string;
  kind: SlotKind;
}

export const DEFAULT_MAX_RUNS = 2;

export class RunSlots {
  private readonly held = new Set<Slot>();

  constructor(private readonly maxRuns: () => number = () => DEFAULT_MAX_RUNS) {}

  private max(): number {
    const n = Math.floor(this.maxRuns());
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_RUNS;
  }

  busy(hireId: string): boolean {
    return [...this.held].some((s) => s.hireId === hireId);
  }

  inUse(): number {
    return this.held.size;
  }

  tryAcquire(hireId: string, kind: SlotKind): Slot | null {
    if (this.held.size >= this.max() || this.busy(hireId)) return null;
    const slot: Slot = {
      hireId,
      kind,
      release: () => {
        this.held.delete(slot);
      },
    };
    this.held.add(slot);
    return slot;
  }

  /** The jobs to start now, from the queue in its order: chats first, one per free hire. */
  pick(queue: readonly QueuedJob[]): QueuedJob[] {
    const free = this.max() - this.held.size;
    const taken = new Set([...this.held].map((s) => s.hireId));
    const out: QueuedJob[] = [];
    for (const kind of ['chat', 'routine'] as const) {
      for (const job of queue) {
        if (out.length >= free) return out;
        if (job.kind !== kind || taken.has(job.hireId)) continue;
        taken.add(job.hireId);
        out.push(job);
      }
    }
    return out;
  }
}
