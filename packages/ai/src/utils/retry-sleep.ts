/** Wait out the backoff without racing a caller's deadline in the same timer pass. */
export function sleepForRetry(ms: number, signal: AbortSignal | undefined, abortError: () => Error): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		const finish = () => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		let turn: ReturnType<typeof setImmediate> | undefined;
		let timer = setTimeout(() => {
			// Other timers already due must be able to cancel the retry before it starts.
			if (typeof setImmediate === "function") turn = setImmediate(finish);
			else timer = setTimeout(finish, 0);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			if (turn !== undefined) clearImmediate(turn);
			reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
