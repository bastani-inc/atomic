import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessage } from "../src/types.ts";
import { assistantRetryDelayMs, type RetryPolicy, retryAssistantCall } from "../src/utils/retry.ts";
import { getProviderRetryAfterMs, getRetryAfterMs } from "../src/utils/retry-hints.ts";

const policy: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxRetryDelayMs: 60_000 };

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function failure(errorMessage: string, retryAfterMs?: number): AssistantMessage {
	return { ...fauxAssistantMessage("", { stopReason: "error", errorMessage }), retryAfterMs };
}

async function runRetries(responses: AssistantMessage[], retryPolicy: RetryPolicy = policy) {
	vi.useFakeTimers();
	const delays: number[] = [];
	let calls = 0;
	const produce = async () => {
		calls++;
		return responses.shift() ?? fauxAssistantMessage("recovered");
	};
	const pending = retryAssistantCall(produce, retryPolicy, undefined, {
		onRetryScheduled: (_attempt, _max, delayMs) => {
			delays.push(delayMs);
		},
	});
	await vi.runAllTimersAsync();
	return { result: await pending, delays, calls };
}

test("a 520 burst with retry_after recovers within maxRetries, waiting as long as the server asks (#3623)", async () => {
	const burst = [45_000, 45_000, 45_000].map((hint) => failure("520 status code (no body)", hint));
	const { result, delays, calls } = await runRetries(burst);
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(delays, [45_000, 45_000, 45_000]);
	assert.equal(calls, 4);
});

test("a 520 burst longer than maxRetries hinted waits still gives up after maxRetries (#3623)", async () => {
	const burst = Array.from({ length: 10 }, () => failure("520 status code (no body)", 45_000));
	const { result, delays, calls } = await runRetries(burst);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(delays, [45_000, 45_000, 45_000]);
	assert.equal(calls, 4);
});

test("a server retry hint is capped by maxRetryDelayMs, defaulting to 60 seconds (#3623)", () => {
	const message = failure("503 service unavailable", 18_000_000);
	assert.equal(assistantRetryDelayMs({ ...policy, maxRetryDelayMs: 30_000 }, 1, message), 30_000);
	assert.equal(assistantRetryDelayMs({ ...policy, maxRetryDelayMs: undefined }, 1, message), 60_000);
	assert.equal(assistantRetryDelayMs({ ...policy, maxRetryDelayMs: 0, maxAgentDelayMs: 20_000 }, 1, message), 20_000);
});

test("a 5xx without a retry hint keeps the 2s/4s/8s backoff and the maxRetries limit (#3623)", async () => {
	const outage = Array.from({ length: 10 }, () => failure("503 service unavailable"));
	const { result, delays, calls } = await runRetries(outage);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(delays, [2000, 4000, 8000]);
	assert.equal(calls, 4);
});

test.each([
	"400 invalid request: max_tokens must be <= 512",
	"429 You exceeded your current quota: insufficient_quota",
])("%s fails immediately even with a retry hint (#3623)", async (errorMessage) => {
	const { result, delays, calls } = await runRetries([failure(errorMessage, 5000)]);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(delays, []);
	assert.equal(calls, 1);
});

test.each(["521 Web server is down", "522 Connection timed out", "523 Origin is unreachable", "read ECONNRESET"])(
	"%s is retryable (#3623)",
	(errorMessage) => {
		assert.equal(assistantRetryDelayMs(policy, 1, failure(errorMessage)), 2000);
	},
);

test("a 400 whose request id contains 521 stays non-retryable (#3623)", () => {
	assert.equal(assistantRetryDelayMs(policy, 1, failure("400 invalid request (request id req_85213)")), undefined);
});

test("parses Retry-After-Ms, Retry-After seconds and dates, and the Cloudflare body retry_after (#3623)", () => {
	const now = Date.parse("2026-10-14T12:00:00Z");
	assert.equal(getRetryAfterMs(new Headers({ "retry-after-ms": "1500" }), undefined, now), 1500);
	assert.equal(getRetryAfterMs(new Headers({ "retry-after": "7" }), undefined, now), 7000);
	assert.equal(
		getRetryAfterMs(new Headers({ "retry-after": "Wed, 14 Oct 2026 12:00:30 GMT" }), undefined, now),
		30_000,
	);
	assert.equal(getRetryAfterMs(undefined, '{"retry_after":12,"error_code":520}', now), 12_000);
	assert.equal(getRetryAfterMs(new Headers({ "retry-after": "soon" }), "<html>520</html>", now), undefined);
	assert.equal(getProviderRetryAfterMs({ retryAfterMs: 1500 }), 1500);
	assert.equal(getProviderRetryAfterMs(new Error("plain")), undefined);
});
