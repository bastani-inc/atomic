/**
 * What a pool does with the wake-ups that say its root's work may be ready (#5103, #5230): Postgres notifications from
 * its journal, and on the root's own host the writes it makes itself. A wake-up only ends an idle claim's pause early:
 * the pause still ends on its own, so a lost wake-up costs at most {@link IDLE_CLAIM_FALLBACK_MS}.
 */

/** The first pause of an idle worker between asks for work, before jitter doubles it at most. */
export const IDLE_CLAIM_FIRST_PAUSE_MS = 25;
/**
 * The longest pause of an idle worker between asks for work (#5230). Its pauses grow to this while nothing is ready,
 * so it bounds how late a ready child is claimed when every wake-up is lost: on a store without notifications (SQLite,
 * sqld, Postgres through a transaction pooler) and while a dropped listening connection reconnects.
 */
export const IDLE_CLAIM_FALLBACK_MS = 2_000;

/**
 * One idle worker's pauses (#5230): each pause while nothing is ready doubles, from {@link IDLE_CLAIM_FIRST_PAUSE_MS}
 * (25–50 ms with jitter) up to {@link IDLE_CLAIM_FALLBACK_MS}. A successful claim or new pool control resets it.
 */
export class IdleClaimBackoff {
	private step = 0;
	/**
	 * A wake-up ended the worker's last claim, which found no work: its next claim, the worker's answer to that wake-up,
	 * passes the wake-up on when it finds work, as a claim woken while it checked does.
	 */
	carriesWake = false;

	constructor(private readonly random: () => number = Math.random) {}

	/** The pause to wait now; the next one is twice as long, up to the cap. */
	next(): number {
		const base = IDLE_CLAIM_FIRST_PAUSE_MS * 2 ** Math.min(this.step, 16);
		this.step++;
		return Math.min(IDLE_CLAIM_FALLBACK_MS, base * (1 + this.random()));
	}

	reset(): void {
		this.step = 0;
	}
}

/** One idle claim, registered before it checks for work, so a wake-up while it checks is never lost. */
class IdleClaimTicket {
	woken = false;
	private end?: () => void;

	/** Whether the claim's check is over and it waits out its pause. */
	get pausing(): boolean {
		return this.end !== undefined;
	}

	wake(): void {
		this.woken = true;
		this.end?.();
	}

	/** Resolves after `ms`, once woken, or once `signal` aborts: at once when a wake-up came while the claim checked. */
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

/**
 * The idle claims of a pool's workers, and the wake-ups that end their pauses (#5230). Each claim registers before it
 * checks for work and pauses only after the check found none, so a wake-up between the check and the pause ends the
 * pause at once: none is lost. A wake-up that names the root ends one pause, preferring a claim already pausing over
 * one still checking; that one claims again, and when it finds work it passes the wake-up on, since one notification
 * may stand for several ready children (Postgres sends one per transaction). The wake-up that ended a pause carries
 * over to the worker's next claim, across its round trip, through the worker's backoff.
 */
export class IdleClaimWaits {
	private readonly tickets = new Set<IdleClaimTicket>();

	/**
	 * Runs `check`, which claims work or finds none, under a registration made first. Found work resets `backoff`.
	 * Without work, resolves undefined after the backoff's next pause, or once a wake-up ends it: at once when one came
	 * during the check. A wake-up does not reset the backoff by itself: a woken claim that finds nothing, as after an
	 * attempt's end, pauses as long as it would have. The claim of a worker that exited (`signal`) stops waiting at once
	 * and takes no more wake-ups.
	 */
	async claim<T>(
		backoff: IdleClaimBackoff,
		check: () => Promise<T | undefined>,
		signal?: AbortSignal,
	): Promise<T | undefined> {
		const ticket = new IdleClaimTicket();
		this.tickets.add(ticket);
		const carried = backoff.carriesWake;
		backoff.carriesWake = false;
		try {
			const claimed = await check();
			if (claimed !== undefined) {
				backoff.reset();
				this.tickets.delete(ticket);
				if (ticket.woken || carried) this.wakeOne();
				return claimed;
			}
			await ticket.pause(backoff.next(), signal);
			backoff.carriesWake = ticket.woken;
			return undefined;
		} finally {
			this.tickets.delete(ticket);
		}
	}

	/** Whether a claim waits out its pause now, not woken yet: an idle worker a wake-up would reach. */
	get pausing(): boolean {
		for (const ticket of this.tickets) if (ticket.pausing && !ticket.woken) return true;
		return false;
	}

	/**
	 * A wake-up from the journal for `woken`, the root this pool serves being `root`: one pause ends for a wake-up naming
	 * it, every pause when wake-ups may have been missed (undefined), none for another root.
	 */
	wake(woken: string | undefined, root: string | undefined): void {
		if (woken === undefined) this.wakeAll();
		else if (woken === root) this.wakeOne();
	}

	/** Ends one claim's pause: the oldest pausing claim not woken yet, else the oldest one still checking. */
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

	/** Ends every claim's pause, and makes every claim checking now claim again at once. */
	wakeAll(): void {
		for (const ticket of [...this.tickets]) ticket.wake();
	}
}

/**
 * How often a host whose store sends it no wake-ups reads whether its root's work became ready, while any of its
 * workers is idle (#5230): one small read per host, instead of a claim per idle worker. It bounds how late an idle worker
 * on such a store (SQLite, sqld, Postgres through a transaction pooler or while its listening connection is down) claims
 * a child that became ready on another host.
 */
export const IDLE_READY_PROBE_MS = 250;

/** What an {@link IdleReadyProbe} reads and wakes. */
export interface IdleReadyProbeTarget {
	readonly waits: IdleClaimWaits;
	/** Whether the host's wake-ups arrive now: the store sends them and its listening connection listens. */
	readonly notified: () => Promise<boolean>;
	/** The root's claimable work as a mark that changes whenever some becomes ready; undefined when none is. */
	readonly mark: () => Promise<string | undefined>;
}

/**
 * A host's stand-in for wake-ups its store does not send (#5230): while one of its workers pauses idle, each tick reads
 * the root's ready mark, and a mark that changed to show ready work ends one pause, as a wake-up would. A mark that did
 * not change wakes nobody: what it shows is work a woken claim already found, or that this host cannot take.
 */
export class IdleReadyProbe {
	private last: string | undefined;
	private reading = false;

	constructor(private readonly target: IdleReadyProbeTarget) {}

	async tick(): Promise<void> {
		if (this.reading || !this.target.waits.pausing) return;
		this.reading = true;
		try {
			if (await this.target.notified()) {
				// Once wake-ups stop again, whatever is ready then is news.
				this.last = undefined;
				return;
			}
			// A read the store refused is no news: the workers' own pauses still end.
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
