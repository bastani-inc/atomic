import "../helpers/provider-rate-limit-isolation.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	providerCooldownMs,
	providerRateLimitSnapshot,
	providerRetryHint,
	recordProviderRateLimit,
	recordProviderSuccess,
} from "../../packages/coding-agent/src/core/provider-rate-limits.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("Retry-After accepts seconds and HTTP dates through wrapped failures (#3864)", () => {
	vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
	assert.deepEqual(providerRetryHint({ cause: { status: 429, headers: new Headers({ "Retry-After": "2.5" }) } }), {
		retryAfterMs: 2500,
	});
	assert.deepEqual(providerRetryHint({ headers: new Headers({ "retry-after": "Thu, 22 Oct 2026 12:00:03 GMT" }) }), {
		retryAfterMs: 3000,
	});
	assert.deepEqual(providerRetryHint({ headers: new Headers({ "Retry-After": "not a date" }) }), {});
	assert.deepEqual(providerRetryHint({ retryAfterMs: Number.POSITIVE_INFINITY }), {});
});

test("missing retry hints use bounded exponential jitter, and success resets the backoff (#3864)", () => {
	vi.spyOn(Math, "random").mockReturnValue(0);
	const error = { status: 429 };
	assert.equal(recordProviderRateLimit("jitter", error), 500);
	vi.advanceTimersByTime(500);
	assert.equal(recordProviderRateLimit("jitter", error), 1000);
	vi.spyOn(Math, "random").mockReturnValue(1);
	for (let i = 0; i < 20; i++) {
		vi.advanceTimersByTime(60_000);
		const delay = recordProviderRateLimit("jitter", error);
		assert.ok(delay !== undefined && delay >= 1000 && delay <= 60_000);
	}
	vi.advanceTimersByTime(60_000);
	recordProviderSuccess("jitter");
	assert.equal(recordProviderRateLimit("jitter", error), 1000);
	assert.equal(providerRateLimitSnapshot("jitter")?.rateLimitCount, 23);
	assert.equal(recordProviderRateLimit("ordinary", { status: 500 }), undefined);
	assert.equal(providerRateLimitSnapshot("ordinary"), undefined);
});

test("a later short retry hint never shortens an account's existing cooldown (#3864)", () => {
	recordProviderRateLimit("long-cooldown", { status: 429, retryAfterMs: 120_000 });
	recordProviderRateLimit("long-cooldown", { status: 429, retryAfterMs: 100 });
	assert.equal(providerCooldownMs("long-cooldown"), 120_000);
	assert.deepEqual(Object.keys(providerRateLimitSnapshot("long-cooldown") ?? {}).sort(), [
		"cooldownUntil",
		"provider",
		"rateLimitCount",
	]);
});

test("fractional jittered cooldowns round up to a whole millisecond that a millisecond clock can reach (#3864)", () => {
	vi.spyOn(Math, "random").mockReturnValue(0.0001);
	const jittered = recordProviderRateLimit("fractional", { status: 429 });
	assert.equal(jittered, 501);
	vi.advanceTimersByTime(jittered);
	assert.equal(providerCooldownMs("fractional"), 0);
	const hinted = recordProviderRateLimit("fractional-hint", { status: 429, retryAfterMs: 1500.4 });
	assert.equal(hinted, 1501);
	vi.advanceTimersByTime(hinted);
	assert.equal(providerCooldownMs("fractional-hint"), 0);
});
