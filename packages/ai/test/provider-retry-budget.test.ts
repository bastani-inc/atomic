import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { assistantRetryDelayMs, type RetryPolicy, retryAssistantCall } from "../src/utils/retry.ts";
import { getProviderRetryAfterMs, getRetryAfterMs } from "../src/utils/retry-hints.ts";

const policy: RetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxRetryTimeMs: 5000,
	maxRetryDelayMs: 3000,
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function runRetries(produce: () => Promise<ReturnType<typeof fauxAssistantMessage>>, retryPolicy = policy) {
	vi.useFakeTimers();
	vi.spyOn(Math, "random").mockReturnValue(0.5);
	const delays: number[] = [];
	const result = retryAssistantCall(produce, retryPolicy, undefined, {
		onRetryScheduled: (_attempt, _max, delay) => {
			delays.push(delay);
		},
	});
	await vi.runAllTimersAsync();
	return { result: await result, delays };
}

test("permanent 5xx retries past maxRetries until the elapsed budget is spent (#3623)", async () => {
	const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 unavailable" }));
	const { result, delays } = await runRetries(produce);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(delays, [1000, 2000, 2000]);
	assert.equal(produce.mock.calls.length, 4);
});

test("server hint is the minimum delay, capped by maxRetryDelayMs and the remaining budget (#3623)", async () => {
	const produce = vi.fn(async () => ({
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "520 unavailable" }),
		retryAfterMs: 60_000,
	}));
	const { result, delays } = await runRetries(produce);
	assert.equal(result.stopReason, "error");
	assert.deepEqual(delays, [3000, 2000]);
	assert.equal(produce.mock.calls.length, 3);
});

test.each([
	["429 rate limit", 4],
	["400 invalid request: max_tokens must be <= 512", 1],
	["429 insufficient_quota", 1],
])("keeps existing attempt limits for %s (#3623)", async (errorMessage, expectedCalls) => {
	const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage }));
	const { result } = await runRetries(produce, { ...policy, baseDelayMs: 0 });
	assert.equal(result.stopReason, "error");
	assert.equal(produce.mock.calls.length, expectedCalls);
});

test.each(["521 Web server is down", "522 Connection timed out", "523 Origin is unreachable", "read ECONNRESET"])(
	"classifies %s as a budgeted transient failure (#3623)",
	(errorMessage) => {
		const delay = assistantRetryDelayMs(policy, 10, { stopReason: "error", errorMessage }, 0, () => 0.5);
		assert.equal(delay, 5000);
	},
);

test("jittered delay stays within the exponential backoff bound (#3623)", () => {
	const message = { stopReason: "error", errorMessage: "502 bad gateway" } as const;
	const unbounded = { ...policy, maxRetryTimeMs: 300_000 };
	assert.equal(assistantRetryDelayMs(unbounded, 3, message, 0, () => 0), 0);
	assert.equal(assistantRetryDelayMs(unbounded, 3, message, 0, () => 0.999_999), 7999);
	assert.equal(assistantRetryDelayMs(unbounded, 10, message, 0, () => 0.999_999), 59_999);
});

test("parses Retry-After seconds, HTTP dates and Cloudflare retry_after (#3623)", () => {
	const now = Date.parse("2026-10-14T12:00:00Z");
	assert.equal(getRetryAfterMs(new Headers({ "retry-after": "7" }), undefined, now), 7000);
	assert.equal(getRetryAfterMs(new Headers({ "retry-after": "Wed, 14 Oct 2026 12:00:30 GMT" }), undefined, now), 30_000);
	assert.equal(getRetryAfterMs(undefined, '{"retry_after":12,"error_code":520}', now), 12_000);
	assert.equal(getRetryAfterMs(new Headers({ "retry-after": "soon" }), "<html>520</html>", now), undefined);
	assert.equal(getProviderRetryAfterMs({ headers: new Headers(), error: { retry_after: 4 } }), 4000);
	assert.equal(getProviderRetryAfterMs({ retryAfterMs: 1500 }), 1500);
	assert.equal(getProviderRetryAfterMs(new Error("plain")), undefined);
});
