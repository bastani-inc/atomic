import type { RpcResponse } from "./rpc-types.ts";
import { EXIT_DRAIN_TIMEOUT_MS } from "./rpc-command-timeouts.ts";
import { asAcceptedRequestFailure } from "./rpc-transport-error.ts";

interface PendingRequest {
	/** True once the child announced it owns this request (`engine_request_accepted`). */
	accepted: boolean;
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

/**
 * In-flight RPC requests and their ownership state.
 *
 * Ownership decides whether a submission may be returned to the editor after
 * the transport dies: a request the child never took is still the user's text,
 * while one it had already started may have run side effects. Output cannot
 * answer that — a command can finish, having changed the working tree, and
 * print nothing.
 */
export class RpcPendingRequests {
	private readonly pending = new Map<string, PendingRequest>();

	get size(): number {
		return this.pending.size;
	}

	add(id: string, handlers: Omit<PendingRequest, "accepted">): void {
		this.pending.set(id, { accepted: false, ...handlers });
	}

	has(id: string): boolean {
		return this.pending.has(id);
	}

	delete(id: string): void {
		this.pending.delete(id);
	}

	/** Record the child's admission frame for a request that is still in flight. */
	markAccepted(id: string): void {
		const request = this.pending.get(id);
		if (request) request.accepted = true;
	}

	/** Deliver a response, if the request is still ours to settle. */
	resolve(id: string, response: RpcResponse): boolean {
		const request = this.pending.get(id);
		if (!request) return false;
		this.pending.delete(id);
		request.resolve(response);
		return true;
	}

	/**
	 * Fail everything in flight after transport loss.
	 *
	 * Accepted requests get their own copy of the failure, marked accepted, so a
	 * single engine exit can reject an accepted and an unaccepted request with
	 * honest, different classifications.
	 */
	rejectAll(error: Error): void {
		const requests = [...this.pending.values()];
		this.pending.clear();
		for (const request of requests) {
			request.reject(request.accepted ? asAcceptedRequestFailure(error) : error);
		}
	}

	/**
	 * Fail in-flight requests once the dead child's stdout has been fully parsed.
	 *
	 * `drained` resolves when the reader has delivered its last queued frame, so
	 * an admission frame still in the pipe is seen first and its request is not
	 * misclassified as never accepted. The timer bounds a descendant that
	 * inherited stdout and keeps it open: pending callers must fail, not hang.
	 * `stillCurrent` keeps a late drain from touching a replacement generation.
	 */
	rejectAllAfterDrain(drained: Promise<void>, error: Error, stillCurrent: () => boolean): void {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (stillCurrent()) this.rejectAll(error);
		};
		const timer = setTimeout(finish, EXIT_DRAIN_TIMEOUT_MS);
		timer.unref?.();
		void drained.then(finish, finish);
	}
}
