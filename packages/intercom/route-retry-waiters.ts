import {
	IntercomBrokerTimeoutError,
	isIntercomBrokerTimeout,
	isRecoverableIntercomDisconnect,
} from "./recoverable-disconnect.js";

/**
 * Route publications that arrive while a run waits out its own reconnect backoff.
 *
 * The run's timer owns the retry, and the retry registers the latest route the run published, so a publication
 * needs no connection of its own: it waits for that retry. Every waiter settles exactly once, with the retry's
 * outcome or with the reason the retry will never run.
 */
export class RouteRetryWaiters {
	private pending: PromiseWithResolvers<void> | null = null;

	/** Wait for the scheduled retry. All waiters of one retry share its outcome. */
	join(): Promise<void> {
		this.pending ??= Promise.withResolvers<void>();
		return this.pending.promise;
	}

	/** The retry registered the latest route. */
	succeed(): void {
		this.settle()?.resolve();
	}

	/** The retry failed, or will never run. */
	fail(error: Error): void {
		this.settle()?.reject(error);
	}

	private settle(): PromiseWithResolvers<void> | null {
		const pending = this.pending;
		this.pending = null;
		return pending;
	}
}

/**
 * What a publication that waited on a run's retry is told when the retry fails.
 *
 * A stage that starts inside the run's backoff window awaits that publication, and retries a broker timeout
 * rather than failing. Any other transport loss during the retry is the same transient condition, so it
 * reaches the stage as a broker timeout with the loss as its cause. A failure that is not a transport loss
 * (an authorization refusal, a stale runtime) is not transient and is reported as it happened.
 */
export function scheduledRetryFailure(error: Error): Error {
	if (isIntercomBrokerTimeout(error) || !isRecoverableIntercomDisconnect(error)) return error;
	return new IntercomBrokerTimeoutError("Connection timeout: the run's route registration retry did not complete", {
		cause: error,
	});
}
