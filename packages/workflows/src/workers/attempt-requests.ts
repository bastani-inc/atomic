import type { PoolWork } from "../durable/journal/sql-pool-queue.js";
import { type SerializedError, serializeError } from "../shared/error-codec.js";
import { WorkAttemptFencedError, type WorkAttemptFencedFields } from "../shared/worker-pool-errors.js";
import { infrastructureFaultOf } from "../shared/workflow-infrastructure-error.js";
import { refusedForAWhile, retryWithinLease } from "./lease-outage.js";
import type { WorkerDeliver, WorkerReply, WorkerRequest } from "./protocol.js";
import { workerRefusal } from "./worker-refusal.js";
import type { PendingWorkerRequest, WorkerReplyState } from "./worker-replies.js";

/** A worker request before the sender numbers it. */
export type WorkerRequestBody = WorkerRequest extends infer T
	? T extends WorkerRequest
		? Omit<T, "id">
		: never
	: never;

/**
 * Sends one request to the coordinator and waits for its reply. A storage outage refusing an `outageTolerant` request
 * is left to its caller; any other request's is not (#4768). `attempt` is the attempt the request was made for.
 */
export type WorkerRequestSender = (
	message: WorkerRequestBody,
	deliver?: WorkerDeliver,
	outageTolerant?: boolean,
	attempt?: WorkAttemptFencedFields,
) => Promise<WorkerReply["value"]>;

/** Numbers each request, records it among `pending` for its reply, and sends it with `send`. */
export function workerRequestSender(
	pending: Map<number, PendingWorkerRequest>,
	send: (message: WorkerRequest, sent: (error: Error | null) => void) => void,
): WorkerRequestSender {
	let sequence = 0;
	return (message, deliver, outageTolerant = false, attempt) =>
		new Promise((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, {
				resolve,
				reject,
				deliver,
				...(outageTolerant ? { outageTolerant } : {}),
				...(attempt === undefined ? {} : { attempt }),
			});
			send({ ...message, id } as WorkerRequest, (error) => {
				if (error) reject(error);
			});
		});
}

/** What {@link AttemptRequests} needs of its worker. */
export interface AttemptRequestsOptions {
	readonly request: WorkerRequestSender;
	readonly replies: WorkerReplyState;
	/** Whether the held attempt's lease, renewed at its claim and by each heartbeat, still lasts. */
	readonly leaseLeft: () => boolean;
	/** How long a request the store refuses is sent again before the attempt hands its child on. */
	readonly outageHandoffMs: number;
}

/**
 * The attempt a worker holds, and the requests it makes for it (#4768). A storage refusal does not end a request while
 * the attempt's lease lasts: it is sent again, for the attempt that made it only. Past the lease, or once that attempt
 * is no longer the worker's, the refusal ends it.
 */
export class AttemptRequests {
	/** The attempt this worker runs, which a refusal of its requests fences. */
	held: PoolWork | undefined;
	/** The held attempt while it may still commit: none once its writes are cut off. */
	writable: PoolWork | undefined;
	/** Set when the held attempt ends because the store kept refusing it: the pool hands its child on, uncounted. */
	private handoff = false;
	/** The store's refusal the held attempt ended on, for the pool to name when the child runs out of attempts. */
	private fault: Error | undefined;

	constructor(private readonly options: AttemptRequestsOptions) {}

	/** Forgets how the previous attempt ended, before the worker claims its next one. */
	reset(): void {
		this.handoff = false;
		this.fault = undefined;
	}

	/** Holds `work`, which may commit until its writes are cut off. */
	hold(work: PoolWork): void {
		this.held = work;
		this.writable = work;
	}

	/** Sends `message` for the attempt it belongs to, again while the store refuses it within the attempt's lease. */
	async send(message: WorkerRequestBody): Promise<WorkerReply["value"]> {
		// A commit belongs to the attempt that may still write, which outlasts the worker's hold on it while a fenced
		// attempt's stage sessions close and write their last entries; any other request belongs to the attempt held.
		const owner = () => (message.kind === "commit" ? this.writable : this.held);
		const held = owner();
		const attempt = held === undefined ? undefined : { workId: held.id, generation: held.generation };
		// Every send, the first included, is for the attempt that made the request, while it is still that attempt's to
		// make: an ended attempt's write never reaches its replay.
		const current = () => held !== undefined && owner() === held;
		try {
			return await retryWithinLease(
				() => {
					if (!current())
						return Promise.reject(new WorkAttemptFencedError(attempt ?? { workId: "", generation: 0 }));
					return this.options.request(message, undefined, true, attempt);
				},
				() => current() && this.options.leaseLeft(),
				`a ${message.kind} request`,
				this.options.outageHandoffMs,
			);
		} catch (error) {
			if (infrastructureFaultOf(error) !== "storage_unavailable" || this.held === undefined || this.held !== held)
				throw error;
			this.options.replies.attemptFenced = true;
			this.fault = error as Error;
			// The store refused it for a while past the handoff bound, within the lease: another host may get through,
			// so the child goes there without spending one of its attempts. A refusal no host gets through, or one past the
			// lease, ends the attempt as a counted failure that names the refusal.
			if (refusedForAWhile(error) && this.options.leaseLeft()) this.handoff = true;
			throw workerRefusal(error as Error, attempt).error;
		}
	}

	/**
	 * The request that ends the held attempt at the pool: `ended`, with the store's refusal it ended on when `ended`
	 * names no fault of its own, and marked a handoff when the store kept refusing it within its lease.
	 */
	end(ended: { readonly kind: "fenced"; readonly fault?: SerializedError }): {
		readonly kind: "fenced";
		readonly fault?: SerializedError;
		readonly handoff?: true;
	} {
		return {
			...ended,
			...(ended.fault === undefined && this.fault !== undefined ? { fault: serializeError(this.fault) } : {}),
			...(this.handoff ? { handoff: true as const } : {}),
		};
	}
}
