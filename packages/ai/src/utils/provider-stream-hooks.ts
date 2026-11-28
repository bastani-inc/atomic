import type { StreamOptions } from "../types.ts";
import { ProviderWaitTimeoutError, withProviderTimeout } from "./provider-waits/timeout.ts";
import { StreamDeadlineError, type StreamDeadlineHandle } from "./stream-deadline.ts";

/** Guard extension callbacks at adapter entry so their waits can't hold the stream open. */
export function withBoundedProviderHooks<T extends StreamOptions | undefined>(options: T, stream: StreamDeadlineHandle): T {
	if (!options?.onPayload && !options?.onResponse && !options?.onProviderStreamEvent) return options;
	const guard = <Args extends unknown[], Result>(
		name: string,
		hook: ((...args: Args) => Result | Promise<Result>) | undefined,
		timeoutMs: number | undefined,
	) => hook && (async (...args: Args): Promise<Result> => {
		try {
			return await withProviderTimeout(timeoutMs, stream.signal, async () => hook(...args), `Provider ${name} hook`);
		} catch (error) {
			if (options.signal?.aborted) throw new Error(`Provider ${name} hook interrupted`, { cause: error });
			if (error instanceof StreamDeadlineError) throw new Error(`Provider ${name} hook stalled: ${error.message}`, { cause: error });
			if (error instanceof ProviderWaitTimeoutError) stream.abort(error);
			throw error;
		}
	});
	return {
		...options,
		onPayload: guard("onPayload", options.onPayload, options.timeoutMs),
		onResponse: guard("onResponse", options.onResponse, options.timeoutMs),
		onProviderStreamEvent: guard("onProviderStreamEvent", options.onProviderStreamEvent, stream.deadlineMs ?? options.timeoutMs),
	};
}
