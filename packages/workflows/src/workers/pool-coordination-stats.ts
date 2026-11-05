import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolCoordinationCount, PoolCoordinationStats } from "../shared/store-types.js";

/** What a write outside any request or root command counts as. */
const UNATTRIBUTED_WRITE = "other";

function rates(counts: ReadonlyMap<string, number>, seconds: number): Record<string, PoolCoordinationCount> {
	return Object.fromEntries(
		[...counts].map(([kind, count]) => [kind, { count, perSecond: count / seconds }] as const),
	);
}

/**
 * A pool coordinator's traffic since it started: requests by kind, and journal write transactions by the kind of the
 * request or task that submitted them. A write is attributed through the async context `within` runs its task in.
 */
export class PoolCoordinationCounters {
	private readonly since = Date.now();
	private readonly requests = new Map<string, number>();
	private readonly writes = new Map<string, number>();
	private readonly context = new AsyncLocalStorage<string>();
	private changed = false;

	request(kind: string): void {
		this.requests.set(kind, (this.requests.get(kind) ?? 0) + 1);
		this.changed = true;
	}

	write(): void {
		const kind = this.context.getStore() ?? UNATTRIBUTED_WRITE;
		this.writes.set(kind, (this.writes.get(kind) ?? 0) + 1);
		this.changed = true;
	}

	/** Counts the writes of the rest of the current task, and of what it starts, as `kind`'s: for a timer's callback. */
	enter(kind: string): void {
		this.context.enterWith(kind);
	}

	/** Runs `task` so that the writes it submits, now or later in its async continuations, count as `kind`'s. */
	within<T>(kind: string, task: () => T): T {
		return this.context.run(kind, task);
	}

	/** The counts so far, or undefined when nothing was counted since the last sample taken with `changedOnly`. */
	sample(changedOnly = false, now = Date.now()): PoolCoordinationStats | undefined {
		if (changedOnly && !this.changed) return undefined;
		this.changed = false;
		const seconds = Math.max(now - this.since, 1) / 1_000;
		return { since: this.since, requests: rates(this.requests, seconds), writes: rates(this.writes, seconds) };
	}
}
