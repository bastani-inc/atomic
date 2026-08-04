/**
 * Compatibility exports for the shared Atomic retry policy, plus the workflow's
 * abort-aware sleep.
 *
 * The decision/backoff policy is implemented in @bastani/atomic so main chat and
 * workflow stages cannot drift into different budgets for the same
 * `settings.retry` values.
 */

export type { RetryDecision, RetryPolicySettings } from "@bastani/atomic";
export { nextRetryDecision } from "@bastani/atomic";

type WorkflowAbortReason = Error | DOMException | string;

function abortReason(signal: AbortSignal | undefined): WorkflowAbortReason {
	const reason = signal?.reason;
	if (reason instanceof Error || reason instanceof DOMException || typeof reason === "string") return reason;
	return new Error("atomic-workflows: workflow cancelled");
}

/** Sleep for a bounded interval and reject promptly when the signal aborts. */
export function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
		const finish = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const fail = (error: WorkflowAbortReason): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cleanup();
			reject(error);
		};
		const timer = setTimeout(finish, Math.max(0, ms));
		const onAbort = (): void => fail(abortReason(signal));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
