import type { PoolWork } from "../durable/journal/sql-pool-queue.js";
import type { WorkerRequest } from "./protocol.js";

/**
 * How one request a pool worker sent waits for the others it has in flight with the coordinator (#4315).
 *
 * - `barrier`: starts once every earlier request has settled, and every later one starts after it settles.
 * - `commits` and `heartbeats`: each a sequence. A request starts once the latest barrier and the previous request of
 *   its sequence have settled, so the requests of one sequence run one at a time in the order the worker sent them.
 * - `free`: starts once the latest barrier has settled, alongside every other request.
 * - `detached`: a free request that neither a later barrier nor {@link WorkerRequestLanes.settled} waits for.
 */
export type WorkerRequestLane = "barrier" | "commits" | "heartbeats" | "free" | "detached";

const SEQUENCES: ReadonlySet<WorkerRequestLane> = new Set(["commits", "heartbeats"]);

type OneWayWorkerMessage =
	| "delivery-ack"
	| "stage-command-result"
	| "stage-events"
	| "stage-watch-ended"
	| "rate-limits";

/** Requests the coordinator answers. */
export type AnsweredWorkerRequest = Exclude<WorkerRequest["kind"], OneWayWorkerMessage>;

/**
 * The lane of each request. Those that take or end the worker's attempt are barriers, so nothing of one attempt runs
 * alongside its claim or its end. Journal commits are a sequence: a worker's writes apply in the order it sent them,
 * each after the previous one committed. What the worker's heartbeat repeats (lease renewals, control polls and their
 * acknowledgements, usage reports) is a sequence of its own, which keeps that background traffic at one journal
 * transaction per worker at a time, as before, while the requests of an agent step no longer wait behind it. Admission
 * checks, activity and routes are free. A delivery waits on the worker's own acknowledgements, so it stays detached
 * as it was outside the worker's serial chain before.
 */
export const WORKER_REQUEST_LANES: Readonly<Record<AnsweredWorkerRequest, WorkerRequestLane>> = {
	ready: "barrier",
	claim: "barrier",
	fenced: "barrier",
	recycle: "barrier",
	complete: "barrier",
	commit: "commits",
	heartbeat: "heartbeats",
	control: "heartbeats",
	controlled: "heartbeats",
	budget: "free",
	activity: "free",
	route: "free",
	delivery: "detached",
	"delivery-ready": "detached",
};

/** Schedules one worker's requests by {@link WorkerRequestLane}; a request that fails releases its successors too. */
export class WorkerRequestLanes {
	/** Settles once the latest barrier has. */
	private barrier: Promise<void> = Promise.resolve();
	/** Settles, for each sequence, once its latest request has. */
	private readonly sequences = new Map<WorkerRequestLane, Promise<void>>();
	/** Settles once every request scheduled so far, except detached ones, has. */
	private everything: Promise<void> = Promise.resolve();

	run<T>(lane: WorkerRequestLane, request: () => Promise<T>): Promise<T> {
		const after = lane === "barrier" ? this.everything : Promise.all([this.barrier, this.sequences.get(lane)]);
		const result = after.then(request);
		// Its successors wait for it to settle either way; its outcome, failure included, is the caller's.
		const settled = Promise.allSettled([result]).then(() => {});
		if (lane === "barrier") this.barrier = settled;
		if (SEQUENCES.has(lane)) this.sequences.set(lane, settled);
		if (lane !== "detached") this.everything = Promise.all([this.everything, settled]).then(() => {});
		return result;
	}

	/** Settles once every request scheduled so far, except detached ones, has settled. */
	settled(): Promise<void> {
		return this.everything;
	}
}

/** What a worker holds: the attempt it runs, if any. */
export interface AttemptHolder {
	work?: PoolWork;
}

function attemptKey(work: PoolWork): string {
	return `${work.id}#${work.generation}`;
}

/**
 * One worker's work-lease extensions (#4315). Requests in flight together that each need their attempt's lease extended
 * share one extension, one journal transaction rather than one each. The worker takes the extended lease only while it
 * still holds that attempt: an extension that lands after the attempt ended, or after the worker took another one,
 * leaves what it holds as it is.
 */
export class AttemptLeaseExtensions {
	private readonly inFlight = new Map<string, Promise<PoolWork>>();

	constructor(
		private readonly holder: AttemptHolder,
		private readonly extendLease: (attempt: PoolWork) => Promise<PoolWork>,
	) {}

	/** Extends `attempt`'s lease, or joins its extension already in flight. */
	extend(attempt: PoolWork): Promise<PoolWork> {
		const key = attemptKey(attempt);
		const joined = this.inFlight.get(key);
		if (joined !== undefined) return joined;
		const renewed = this.extendLease(attempt).then((work) => {
			const held = this.holder.work;
			if (held !== undefined && attemptKey(held) === key) this.holder.work = work;
			return work;
		});
		this.inFlight.set(key, renewed);
		const landed = () => this.inFlight.delete(key);
		renewed.then(landed, landed);
		return renewed;
	}

	/** Extends the lease of the attempt the worker holds now; nothing when it holds none. */
	async extendHeld(): Promise<void> {
		const held = this.holder.work;
		if (held !== undefined) await this.extend(held);
	}
}
