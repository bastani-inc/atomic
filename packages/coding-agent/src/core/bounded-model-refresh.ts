import { INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS } from "./model-refresh-timeout.ts";

export type BoundedModelRefreshResult<TResult> =
	| { status: "success"; value: TResult }
	| { status: "timed-out" }
	| { status: "aborted" }
	| { status: "rejected" };

export async function boundedInteractiveModelRefresh<TResult, TOptions extends object>(
	refresh: (options: TOptions & { signal: AbortSignal }) => Promise<TResult>,
	options: TOptions,
	externalSignal?: AbortSignal,
): Promise<BoundedModelRefreshResult<TResult>> {
	const controller = new AbortController();
	if (externalSignal?.aborted) {
		controller.abort();
		return { status: "aborted" };
	}

	let timeout: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: (() => void) | undefined;
	try {
		const refreshPromise = Promise.resolve().then(() => refresh({ ...options, signal: controller.signal }));
		void refreshPromise.catch(() => {});
		const refreshOutcome = refreshPromise.then(
			(value): BoundedModelRefreshResult<TResult> => ({ status: "success", value }),
			(): BoundedModelRefreshResult<TResult> => ({ status: "rejected" }),
		);
		const timedOut = new Promise<BoundedModelRefreshResult<TResult>>((resolve) => {
			timeout = setTimeout(() => {
				controller.abort();
				resolve({ status: "timed-out" });
			}, INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS);
		});
		const aborted = externalSignal
			? new Promise<BoundedModelRefreshResult<TResult>>((resolve) => {
					const onAbort = () => {
						controller.abort();
						resolve({ status: "aborted" });
					};
					removeAbortListener = () => externalSignal.removeEventListener("abort", onAbort);
					externalSignal.addEventListener("abort", onAbort, { once: true });
				})
			: undefined;

		return await Promise.race(aborted ? [refreshOutcome, timedOut, aborted] : [refreshOutcome, timedOut]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		removeAbortListener?.();
	}
}
