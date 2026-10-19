import type { InboundMessageEntry } from "./intercom-utils.js";

export interface InboundIdleClaim {
  entries: InboundMessageEntry[];
  isCurrent(): boolean;
  rollbackFrom(index: number): void;
}

/**
 * FIFO ownership for ordinary inbound messages accepted while the parent is
 * busy. A terminal barrier may claim only entries from its exact child session
 * target; unrelated children retain their original queue positions.
 *
 * #3761: each message id is queued once, and a message already shown in the
 * session (`isConsumed`) is never handed out again, whichever of the idle flush,
 * foreground-detach or terminal-barrier paths takes it.
 */
export class InboundIdleQueue {
  private entries: InboundMessageEntry[] = [];
  private generation = 0;

  constructor(private readonly isConsumed: (messageId: string) => boolean = () => false) {}

  private dropConsumed(): void {
    this.entries = this.entries.filter((entry) => !this.isConsumed(entry.message.id));
  }

  get size(): number {
    return this.entries.length;
  }

  enqueue(entry: InboundMessageEntry): boolean {
    if (this.isConsumed(entry.message.id) || this.entries.some((queued) => queued.message.id === entry.message.id)) return false;
    this.entries.push(entry);
    return true;
  }

  has(entry: InboundMessageEntry): boolean {
    return this.entries.includes(entry);
  }

  remove(entry: InboundMessageEntry): boolean {
    const index = this.entries.indexOf(entry);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return !this.isConsumed(entry.message.id);
  }

  drain(): InboundMessageEntry[] {
    this.dropConsumed();
    const entries = this.entries;
    this.entries = [];
    return entries;
  }

  claimOrdinarySourceTargets(runId: string, sourceSessionTargets: readonly string[], terminalAt = Number.POSITIVE_INFINITY): InboundIdleClaim {
    this.dropConsumed();
    const targets = new Set(sourceSessionTargets);
    const generation = this.generation;
    const original = this.entries;
    const legacyIdsByName = new Map<string, Set<string>>();
    for (const entry of original) {
      if (entry.message.source?.subagentRunId !== undefined || entry.from.name === undefined) continue;
      const ids = legacyIdsByName.get(entry.from.name) ?? new Set<string>();
      ids.add(entry.from.id);
      legacyIdsByName.set(entry.from.name, ids);
    }
    const selected = original.filter((entry) => {
      if (entry.message.expectsReply) return false;
      if (entry.message.timestamp > terminalAt) return false;
      const idMatches = targets.has(entry.from.id);
      const nameMatches = entry.from.name !== undefined && targets.has(entry.from.name);
      if (!idMatches && !nameMatches) return false;
      const sourceRunId = entry.message.source?.subagentRunId;
      if (sourceRunId !== undefined) return sourceRunId === runId;
      return idMatches || (entry.from.name !== undefined && legacyIdsByName.get(entry.from.name)?.size === 1);
    });
    const selectedSet = new Set(selected);
    const originalSet = new Set(original);
    this.entries = original.filter((entry) => !selectedSet.has(entry));
    let settled = false;
    return {
      entries: selected,
      isCurrent: () => generation === this.generation,
      rollbackFrom: (index) => {
        if (settled || generation !== this.generation) return;
        settled = true;
        const undelivered = new Set(selected.slice(index));
        const laterEntries = this.entries.filter((entry) => !originalSet.has(entry));
        this.entries = original
          .filter((entry) => !selectedSet.has(entry) || undelivered.has(entry))
          .concat(laterEntries);
      },
    };
  }

  clear(): void {
    this.generation++;
    this.entries = [];
  }
}
