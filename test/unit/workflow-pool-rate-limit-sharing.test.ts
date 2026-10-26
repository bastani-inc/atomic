import assert from "node:assert/strict";
import type { ProviderRateLimitObservation } from "@bastani/atomic";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	RATE_LIMIT_SHARE_INTERVAL_MS,
	RateLimitObservationOutbox,
	RateLimitObservationSet,
} from "../../packages/workflows/src/workers/rate-limit-sharing.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const cooldown = (untilEpochMs: number, model?: string): ProviderRateLimitObservation => ({
	provider: "p",
	...(model === undefined ? {} : { model }),
	kind: "cooldown",
	untilEpochMs,
});

test("the pool sends a scope's first limit at once and coalesces later growth to one message per interval (#4023)", () => {
	const now = Date.now();
	const sent: (readonly ProviderRateLimitObservation[])[] = [];
	const outbox = new RateLimitObservationOutbox((observations) => sent.push(observations));
	outbox.offer(cooldown(now + 1_000));
	outbox.offer(cooldown(now + 2_000));
	outbox.offer(cooldown(now + 3_000));
	// A shorter limit, or another scope's, does not wait on this one.
	outbox.offer(cooldown(now + 2_500));
	outbox.offer(cooldown(now + 500, "m1"));
	assert.deepEqual(sent, [[cooldown(now + 1_000)], [cooldown(now + 500, "m1")]]);
	vi.advanceTimersByTime(RATE_LIMIT_SHARE_INTERVAL_MS - 1);
	assert.equal(sent.length, 2);
	vi.advanceTimersByTime(1);
	assert.deepEqual(sent[2], [cooldown(now + 3_000)]);
	// Nothing new to send: an equal end does not go again.
	outbox.offer(cooldown(now + 3_000));
	vi.advanceTimersByTime(RATE_LIMIT_SHARE_INTERVAL_MS * 4);
	assert.equal(sent.length, 3);
	outbox.close();
});

test("the pool's merged limits keep each scope's latest end and drop ended ones (#4023)", () => {
	const now = Date.now();
	const limits = new RateLimitObservationSet();
	assert.equal(limits.merge(cooldown(now + 1_000)), true);
	assert.equal(limits.merge(cooldown(now + 500)), false);
	assert.equal(limits.merge(cooldown(now + 2_000, "m1")), true);
	assert.equal(limits.merge({ provider: "p", kind: "unavailable", untilEpochMs: now + 3_000 }), true);
	assert.equal(limits.merge(cooldown(now)), false);
	vi.advanceTimersByTime(1_000);
	assert.deepEqual(limits.current(), [
		cooldown(now + 2_000, "m1"),
		{ provider: "p", kind: "unavailable", untilEpochMs: now + 3_000 },
	]);
});
