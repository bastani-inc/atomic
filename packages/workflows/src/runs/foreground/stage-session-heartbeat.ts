export const STAGE_SESSION_HEARTBEAT_INTERVAL_MS = 30_000;

export interface StageSessionHeartbeat {
	start(): void;
	stop(): void;
	/**
	 * Stop scheduling and await the checkpoint that is still in flight, so a late
	 * durable failure surfaces at shutdown instead of being discarded with the
	 * cancelled timer. Rejects with a failure recorded earlier via `fail()` too.
	 */
	drain(): Promise<void>;
	fail(error: unknown): void;
	race<T>(work: Promise<T>): Promise<T>;
}

/** Run one non-overlapping, unref'd durability checkpoint every 30 seconds. */
export function createStageSessionHeartbeat(
	checkpoint: () => Promise<void>,
	intervalMs: number = STAGE_SESSION_HEARTBEAT_INTERVAL_MS,
): StageSessionHeartbeat {
	let active = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	let nextDeadline = 0;
	let failure: unknown;
	let inFlight: Promise<void> | undefined;
	let rejectFailure!: (reason: unknown) => void;
	const failureSignal = new Promise<never>((_resolve, reject) => {
		rejectFailure = reject;
	});
	// A race attaches the normal consumer; this guard prevents a late checkpoint
	// rejection from becoming an unhandled process error during teardown.
	void failureSignal.catch(() => undefined);
	const stopScheduling = (): void => {
		active = false;
		generation += 1;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const fail = (error: unknown): void => {
		if (failure !== undefined) return;
		failure = error;
		stopScheduling();
		rejectFailure(error);
	};

	const schedule = (scheduledGeneration: number): void => {
		if (!active || failure !== undefined || scheduledGeneration !== generation) return;
		const delayMs = Math.max(0, nextDeadline - Date.now());
		timer = setTimeout(() => {
			timer = undefined;
			const startedAt = Date.now();
			do nextDeadline += intervalMs;
			while (nextDeadline <= startedAt);
			const running = checkpoint()
				.catch(fail)
				.finally(() => {
					if (inFlight === running) inFlight = undefined;
					schedule(scheduledGeneration);
				});
			inFlight = running;
		}, delayMs);
		(timer as { unref?: () => void }).unref?.();
	};

	const drain = async (): Promise<void> => {
		stopScheduling();
		await inFlight;
		if (failure !== undefined) throw failure;
	};

	return {
		start(): void {
			if (active || failure !== undefined) return;
			active = true;
			generation += 1;
			nextDeadline = Date.now() + intervalMs;
			schedule(generation);
		},
		stop: stopScheduling,
		drain,
		fail,
		race<T>(work: Promise<T>): Promise<T> {
			if (failure !== undefined) return Promise.reject(failure);
			return Promise.race([work, failureSignal]);
		},
	};
}
