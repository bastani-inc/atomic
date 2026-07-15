export class ModelCatalogDiscoveryCoordinator {
	#inFlight: Promise<void> | undefined;

	discover(start: () => Promise<void>, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		let shared = this.#inFlight;
		if (!shared) {
			let resolveShared = (): void => {};
			let rejectShared = (_error: Error): void => {};
			shared = new Promise<void>((resolve, reject) => {
				resolveShared = resolve;
				rejectShared = reject;
			});
			this.#inFlight = shared;
			try {
				void start().then(resolveShared, (cause) => rejectShared(asError(cause)));
			} catch (cause) {
				rejectShared(asError(cause));
			}
			void shared.finally(() => {
				if (this.#inFlight === shared) this.#inFlight = undefined;
			}).catch(() => undefined);
		}
		return waitForSharedDiscovery(shared, signal);
	}
}

async function waitForSharedDiscovery(shared: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return shared;
	if (signal.aborted) throw abortReason(signal);
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			shared,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(abortReason(signal));
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("Model catalog discovery cancelled", "AbortError");
}

function asError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error("Model catalog discovery failed.");
}
