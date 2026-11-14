import type { PoolWork } from "../durable/journal/sql-pool-queue.js";
import { rehydrateError, serializeError } from "../shared/error-codec.js";
import { infrastructureFaultOf } from "../shared/workflow-infrastructure-error.js";
import type { WorkerDeliver, WorkerReply, WorkerRequest } from "./protocol.js";
import { workerRefusal } from "./worker-refusal.js";

/** A worker request waiting for its reply; a delivery request also receives the deliveries it asked for. */
export interface PendingWorkerRequest {
	readonly resolve: (value: WorkerReply["value"]) => void;
	readonly reject: (error: Error) => void;
	readonly deliver?: WorkerDeliver;
	/**
	 * A storage outage refusing this request does not fence the attempt: the request's caller decides, as a heartbeat
	 * that keeps its attempt while its lease lasts does (#4768).
	 */
	readonly outageTolerant?: boolean;
}

/** What a worker learned from its replies about its attempt and its root: once set, neither goes back. */
export interface WorkerReplyState {
	/** The attempt ends without failing the worker: a fault of the pool, a stale work lease among them, refused it. */
	attemptFenced: boolean;
	/** The root no longer holds its lease: the worker ends cleanly instead of crashing. */
	rootLeaseLost: boolean;
	/** The pool runs more workers than its waiting children need: this idle worker ends cleanly, and is not replaced. */
	retired: boolean;
}

/**
 * Applies one reply of the coordinator. A delivery runs on the request that asked for it and is acknowledged, with its
 * failure when it failed; it returns that acknowledgement's completion. Any other reply settles its request: with its
 * value, or with its refusal decided by type, which may fence the attempt (`held`, when the worker holds one) or
 * report the root's lease lost.
 */
export function receiveWorkerReply(
	reply: WorkerReply,
	pending: Map<number, PendingWorkerRequest>,
	state: WorkerReplyState,
	held: Pick<PoolWork, "id" | "generation"> | undefined,
	send: (message: WorkerRequest) => void,
): Promise<void> | undefined {
	const receiver = pending.get(reply.id);
	if (reply.delivery) {
		const delivery = reply.delivery;
		return Promise.resolve()
			.then(() => {
				if (!receiver?.deliver) throw new Error("Worker delivery receiver is gone");
				return receiver.deliver(delivery.from, delivery.message);
			})
			.then(
				() => send({ id: 0, kind: "delivery-ack", deliveryId: delivery.id }),
				(error: unknown) =>
					send({ id: 0, kind: "delivery-ack", deliveryId: delivery.id, error: serializeError(error) }),
			);
	}
	pending.delete(reply.id);
	if (reply.retire === true) state.retired = true;
	if (reply.error === undefined) {
		receiver?.resolve(reply.value);
		return undefined;
	}
	const error = rehydrateError(reply.error);
	if (receiver?.outageTolerant === true && infrastructureFaultOf(error) === "storage_unavailable") {
		receiver.reject(error);
		return undefined;
	}
	const refusal = workerRefusal(
		error,
		held === undefined ? undefined : { workId: held.id, generation: held.generation },
	);
	if (refusal.kind === "root-lease-lost") state.rootLeaseLost = true;
	if (refusal.kind !== "refused") state.attemptFenced = true;
	receiver?.reject(refusal.error);
	return undefined;
}
