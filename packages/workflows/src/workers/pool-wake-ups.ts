export const IDLE_CLAIM_FIRST_PAUSE_MS = 25;
export const IDLE_CLAIM_FALLBACK_MS = 2_000;

export class IdleClaimBackoff {
	private step = 0;
	private carriedWake?: { readonly signal: AbortSignal | undefined; readonly release: () => void };

	constructor(private readonly random: () => number = Math.random) {}

	next(): number {
		const base = IDLE_CLAIM_FIRST_PAUSE_MS * 2 ** Math.min(this.step, 16);
		this.step++;
		return Math.min(IDLE_CLAIM_FALLBACK_MS, base * (1 + this.random()));
	}

	reset(): void {
		this.step = 0;
	}

	takeWake(): boolean {
		const carried = this.carriedWake;
		if (carried === undefined) return false;
		carried.signal?.removeEventListener("abort", carried.release);
		this.carriedWake = undefined;
		return true;
	}

	carryWake(signal: AbortSignal | undefined, wake: () => void): void {
		const release = () => {
			if (this.takeWake()) wake();
		};
		this.carriedWake = { signal, release };
		signal?.addEventListener("abort", release, { once: true });
		if (signal?.aborted) release();
	}
}

class IdleClaimTicket {
	woken = false;
	private end?: () => void;

	get pausing(): boolean {
		return this.end !== undefined;
	}

	wake(): void {
		this.woken = true;
		this.end?.();
	}

	pause(ms: number, signal?: AbortSignal): Promise<void> {
		if (this.woken || signal?.aborted === true) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.end?.(), ms);
			const abort = () => this.end?.();
			signal?.addEventListener("abort", abort, { once: true });
			this.end = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.end = undefined;
				resolve();
			};
		});
	}
}

export class IdleClaimWaits {
	private readonly tickets = new Set<IdleClaimTicket>();

	async claim<T>(
		backoff: IdleClaimBackoff,
		check: (found: () => void) => Promise<T | undefined>,
		signal?: AbortSignal,
	): Promise<T | undefined> {
		const ticket = new IdleClaimTicket();
		this.tickets.add(ticket);
		let carried = backoff.takeWake();
		const found = () => {
			backoff.reset();
			const passWake = ticket.woken || carried;
			carried = false;
			ticket.woken = false;
			if (this.tickets.delete(ticket) && passWake) this.wakeOne();
		};
		const abort = () => {
			if (this.tickets.delete(ticket) && (ticket.woken || carried)) this.wakeOne();
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			const claimed = await check(found);
			if (claimed !== undefined) {
				found();
				return claimed;
			}
			if (!signal?.aborted) this.tickets.add(ticket);
			await ticket.pause(backoff.next(), signal);
			if (!signal?.aborted && (ticket.woken || carried)) backoff.carryWake(signal, () => this.wakeOne());
			return undefined;
		} catch (error) {
			if (this.tickets.delete(ticket) && (ticket.woken || carried)) this.wakeOne();
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.tickets.delete(ticket);
		}
	}

	get pausing(): boolean {
		for (const ticket of this.tickets) if (ticket.pausing && !ticket.woken) return true;
		return false;
	}

	wake(woken: string | undefined, root: string | undefined): void {
		if (woken === undefined) this.wakeAll();
		else if (woken === root) this.wakeOne();
	}

	wakeOne(): void {
		let checking: IdleClaimTicket | undefined;
		for (const ticket of this.tickets) {
			if (ticket.woken) continue;
			if (ticket.pausing) {
				ticket.wake();
				return;
			}
			checking ??= ticket;
		}
		checking?.wake();
	}

	wakeAll(): void {
		for (const ticket of [...this.tickets]) ticket.wake();
	}
}

export const IDLE_READY_PROBE_MS = 250;

export interface IdleReadyProbeTarget {
	readonly waits: IdleClaimWaits;
	readonly notified: () => Promise<boolean>;
	readonly mark: () => Promise<string | undefined>;
}

export class IdleReadyProbe {
	private last: string | undefined;
	private reading = false;

	constructor(private readonly target: IdleReadyProbeTarget) {}

	async tick(): Promise<void> {
		if (this.reading || !this.target.waits.pausing) return;
		this.reading = true;
		try {
			if (await this.target.notified().catch(() => false)) {
				this.last = undefined;
				return;
			}
			const mark = await this.target.mark().catch(() => this.last);
			if (mark !== undefined && mark !== this.last) this.target.waits.wakeOne();
			this.last = mark;
		} finally {
			this.reading = false;
		}
	}
}

/** What a pool coordinator's wake-ups act on. */
export interface CoordinatorWakeUpTarget {
	/** The root the coordinator's pool serves. */
	readonly root: () => string | undefined;
	/** Whether the coordinator is a worker host's satellite rather than the root's own pool. */
	readonly satellite: boolean;
	readonly pauses: IdleClaimWaits;
	/** The recovery pass in progress, if any. */
	readonly recovering: () => Promise<void> | undefined;
	/** Runs a recovery pass now, which settles what other hosts' workers ended. */
	readonly recover: () => void;
}

/**
 * The listener a pool coordinator gives its journal: a wake-up of its root, or a missed one, ends an idle worker's
 * pause; on the root's own pool it also runs a recovery pass now, or once the one in progress ends, so a child another
 * host finished is settled at once rather than at the next pass.
 */
export function coordinatorWakeUps(target: CoordinatorWakeUpTarget): (root: string | undefined) => void {
	return (woken) => {
		const root = target.root();
		target.pauses.wake(woken, root);
		if (target.satellite || (woken !== undefined && woken !== root)) return;
		const recovering = target.recovering();
		if (recovering === undefined) target.recover();
		else void recovering.finally(target.recover);
	};
}

/**
 * The listener a worker host gives its journal: a wake-up of a root it does not serve, or a missed one, starts a poll
 * that attaches it, at most once per `minIntervalMs`. A served root's satellite hears its root's wake-ups itself.
 */
export function hostWakeUps(
	serves: (root: string) => boolean,
	poll: () => void,
	minIntervalMs: number,
	now: () => number = () => performance.now(),
): (root: string | undefined) => void {
	let polledAt = Number.NEGATIVE_INFINITY;
	return (root) => {
		if (root !== undefined && serves(root)) return;
		const at = now();
		if (at - polledAt < minIntervalMs) return;
		polledAt = at;
		poll();
	};
}
