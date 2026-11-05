/** A worker's heartbeat timer. */
export interface WorkerHeartbeat {
	/** Stops the timer, then waits for the beat in flight, if any. */
	stop(): Promise<void>;
}

/**
 * Runs `beat` every `intervalMs`, and at once when `immediate` is set, never two at a time: a tick that finds the
 * previous beat unanswered does nothing, so a slow answer delays the next beat instead of queueing one per missed tick
 * behind it. `beat` handles its own failures.
 */
export function startWorkerHeartbeat(
	intervalMs: number,
	beat: () => Promise<void>,
	options: { readonly immediate?: boolean } = {},
): WorkerHeartbeat {
	let inFlight: Promise<void> | undefined;
	const pulse = () => {
		inFlight ??= beat().finally(() => {
			inFlight = undefined;
		});
	};
	if (options.immediate === true) pulse();
	const timer = setInterval(pulse, intervalMs);
	return {
		async stop() {
			clearInterval(timer);
			await inFlight;
		},
	};
}

/**
 * A heartbeat that may be refused without consequence, as while a finished attempt's stage sessions close: `send`'s
 * failures that `expected` accepts pass silently, and the first other one is reported through `report`, once.
 */
export function tolerantHeartbeat(
	send: () => Promise<unknown>,
	expected: (error: Error) => boolean,
	report: (error: Error) => void,
): () => Promise<void> {
	let reported = false;
	return async () => {
		try {
			await send();
		} catch (error) {
			if (reported || expected(error as Error)) return;
			reported = true;
			report(error as Error);
		}
	};
}
