import { raceAbort } from "../shared/abort.js";
import type { StageWaitKind } from "../shared/authoring-contract-stage.js";
import { isTerminalStageStatus } from "../shared/store-internal.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { WorkAttemptFencedError, type WorkAttemptFencedFields } from "../shared/worker-pool-errors.js";

/** Waits only something outside the attempt ends: a detached tool call's result, or a person's answer. */
const OUTSIDE_WAITS: ReadonlySet<StageWaitKind> = new Set<StageWaitKind>(["tool", "prompt"]);

/**
 * Whether an attempt waits on nothing it runs itself, as the runs it published show: it has a live stage, every live
 * stage waits with its session released for a detached tool call's result or a person's answer, and none of its
 * durable tool calls runs. A stage the workflow merely holds released (`stage.release()`, idle) does not count: the
 * workflow itself may be busy meanwhile.
 */
export function attemptWaitsReleased(runs: readonly RunSnapshot[]): boolean {
	let waits = false;
	for (const run of runs) {
		if (run.toolNodes.some((node) => node.status === "running")) return false;
		for (const stage of run.stages) {
			if (isTerminalStageStatus(stage.status)) continue;
			if (stage.wait === undefined || !OUTSIDE_WAITS.has(stage.wait.kind)) return false;
			waits = true;
		}
	}
	return waits;
}

/**
 * The workers a pool runs beyond its `count` so attempts that wait released stop occupying the pool: one per waiting
 * attempt, at most `count` of them. A worker that runs a waiting attempt keeps it, so nothing runs twice and no result
 * moves; once fewer attempts wait than extra workers run, an idle worker ends.
 */
export class WaitingWorkerReserve {
	private extra = 0;

	/** Extra workers running or starting. */
	get size(): number {
		return this.extra;
	}

	/** How many more workers to start now that `waiting` attempts wait released; they count as started. */
	grow(waiting: number, count: number): number {
		const wanted = Math.max(0, Math.min(waiting, count) - this.extra);
		this.extra += wanted;
		return wanted;
	}

	/** Whether an idle worker ends now, because fewer than the extra workers' attempts wait; it no longer counts. */
	shrink(waiting: number, count: number): boolean {
		if (this.extra <= Math.min(waiting, count)) return false;
		this.extra -= 1;
		return true;
	}

	/** An extra worker could not start: it no longer counts. */
	lost(): void {
		this.extra = Math.max(0, this.extra - 1);
	}
}

/** A woken attempt's request for a place, answered once: `true` grants one, `false` says its attempt ended. */
interface PlaceRequest<T> {
	readonly holder: T;
	answer(granted: boolean): void;
}

/**
 * The pool's places: at most `count` attempts hold one at once, claims in flight included. An attempt that waits
 * released gives its place back; when it wakes it asks for one again, and freed places go to woken attempts first, in
 * the order they asked, before any new child is claimed.
 */
export class PoolPlaces<T> {
	private readonly holders = new Set<T>();
	private readonly released = new Set<T>();
	private readonly queue: PlaceRequest<T>[] = [];
	private readonly count: () => number;

	constructor(count: () => number) {
		this.count = count;
	}

	/** Attempts and claims that hold a place now. */
	get held(): number {
		return this.holders.size;
	}

	/** Attempts that gave their place back while they wait released, those asking for it again included. */
	get waiting(): number {
		return this.released.size;
	}

	/**
	 * A claim takes a place while one is free; otherwise it gets none. Places are granted as soon as they free, so none
	 * is free while a woken attempt waits for one.
	 */
	claim(holder: T): boolean {
		if (this.holders.size >= this.count()) return false;
		this.holders.add(holder);
		return true;
	}

	/** The holder's attempt waits released: its place goes to the next. */
	release(holder: T): void {
		this.holders.delete(holder);
		this.released.add(holder);
		this.grant();
	}

	/** The holder's woken attempt asks for its place again: `true` once granted, `false` if its attempt ends first. */
	reacquire(holder: T): Promise<boolean> {
		if (!this.released.has(holder)) return Promise.resolve(true);
		return new Promise((answer) => {
			this.queue.push({ holder, answer });
			this.grant();
		});
	}

	/** The holder's attempt ended, or its claim found no child: its place frees, and a place it asked for is refused. */
	end(holder: T): void {
		this.holders.delete(holder);
		this.released.delete(holder);
		const index = this.queue.findIndex((request) => request.holder === holder);
		if (index >= 0) this.queue.splice(index, 1)[0]!.answer(false);
		this.grant();
	}

	private grant(): void {
		for (
			let request = this.queue[0];
			request !== undefined && this.holders.size < this.count();
			request = this.queue[0]
		) {
			this.queue.shift();
			this.released.delete(request.holder);
			this.holders.add(request.holder);
			request.answer(true);
		}
	}
}

/**
 * One attempt's place, as its worker holds it. The attempt gives the place back once it waits released, and takes it
 * back before it starts anything again. Requests go out in order: a place is asked for only after its release was
 * acknowledged. A place granted after its asker gave up is kept, and given back at the next release.
 */
export class AttemptPlace {
	private held = true;
	private releasing: Promise<void> = Promise.resolve();
	private taking: Promise<void> | undefined;
	private readonly ask: (op: "release" | "reacquire") => Promise<boolean>;
	private readonly attempt: WorkAttemptFencedFields;
	private readonly failed: (error: Error) => void;

	constructor(
		ask: (op: "release" | "reacquire") => Promise<boolean>,
		attempt: WorkAttemptFencedFields,
		failed: (error: Error) => void,
	) {
		this.ask = ask;
		this.attempt = attempt;
		this.failed = failed;
	}

	/** Whether the attempt holds its place now. */
	get holds(): boolean {
		return this.held;
	}

	/** What the attempt's runs show: once it waits released while it holds its place, it gives the place back. */
	observe(waits: boolean): void {
		if (!waits || !this.held) return;
		this.held = false;
		this.releasing = this.ask("release").then(
			() => undefined,
			(error: Error) => this.failed(error),
		);
	}

	/**
	 * Take the place back before the attempt starts anything; resolves once the pool grants it. An abort rejects with
	 * its reason and leaves the request in place. An attempt that ended gets no place: a `WorkAttemptFencedError`.
	 */
	async take(signal?: AbortSignal): Promise<void> {
		if (this.held) return;
		signal?.throwIfAborted();
		if (this.taking === undefined) {
			this.taking = this.reacquire();
			this.taking.catch((error: Error) => this.failed(error));
		}
		await raceAbort(this.taking, signal);
	}

	private async reacquire(): Promise<void> {
		try {
			await this.releasing;
			if (!(await this.ask("reacquire"))) throw new WorkAttemptFencedError(this.attempt);
			this.held = true;
		} finally {
			this.taking = undefined;
		}
	}
}
