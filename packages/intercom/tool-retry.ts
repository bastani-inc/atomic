import { setTimeout as delay } from "node:timers/promises";
import { RETRY_IDENTITY_MAX_REUSES, RETRY_IDENTITY_TTL_MS } from "./retry-identity.js";
import { RECONNECT_DELAYS_MS } from "./retry-policy.js";

/** Private attempt results. Retry identity never crosses the registered tool boundary. */
export interface IntercomAttemptResult {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
	details: Record<string, unknown>;
}

/** Wording shared with a released question that reaches the same timeout. */
export function intercomRecoveryStoppedText(reason: string, retries: number): string {
	return `${reason}\nIntercom recovery stopped after ${retries} automatic retries. Delivery may already have occurred. Do not repeat this operation automatically; check with the recipient before intentionally sending a new message.`;
}

/** One invocation owns all retries; separate invocations always start fresh. */
export async function runIntercomOperation(
	attempt: (retryToken: string | undefined, signal: AbortSignal, retries: number) => Promise<IntercomAttemptResult>,
	release: (retryToken: string) => void,
	signal?: AbortSignal,
): Promise<IntercomAttemptResult> {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), RETRY_IDENTITY_TTL_MS);
	const operationSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
	let token: string | undefined;
	let recovering = false;
	let retries = 0;
	let last: IntercomAttemptResult = {
		content: [{ type: "text", text: "Cancelled" }],
		isError: true,
		details: { error: true },
	};
	try {
		for (;;) {
			if (operationSignal.aborted) break;
			last = await attempt(token, operationSignal, retries);
			const { retryToken, retryable, deliveryUncertain, ...details } = last.details;
			last = { ...last, details };
			if (!last.isError) return last;
			recovering ||= deliveryUncertain === true || retryable === true;
			const nextToken = typeof retryToken === "string" ? retryToken : undefined;
			// A retained identity must never be replaced with a fresh operation, even
			// when reconnect, expiry, or authority validation ends recovery.
			const canRetry = nextToken !== undefined || (token === undefined && retryable === true);
			token = nextToken ?? token;
			if (!canRetry) {
				if (!recovering && retryable !== true) return last;
				break;
			}
			recovering = true;
			if (retries >= RETRY_IDENTITY_MAX_REUSES || operationSignal.aborted) break;
			try {
				await delay(RECONNECT_DELAYS_MS[retries], undefined, { signal: operationSignal });
			} catch {
				break;
			}
			retries += 1;
		}
		const reason = operationSignal.aborted ? "Cancelled" : last.content.map(({ text }) => text).join("\n");
		return {
			content: [{
				type: "text",
				text: recovering
					? intercomRecoveryStoppedText(reason, retries)
					: reason,
			}],
			isError: true,
			details: { error: true, terminal: true, automaticRetries: retries, ...(recovering ? { outcome: "unknown" } : {}) },
		};
	} finally {
		clearTimeout(timer);
		if (token !== undefined) release(token);
	}
}
