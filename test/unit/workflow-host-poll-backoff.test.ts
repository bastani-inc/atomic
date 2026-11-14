import assert from "node:assert/strict";
import { test } from "vitest";
import { HOST_POLL_BACKOFF, HostPollBackoff } from "../../packages/workflows/src/workers/host-poll-backoff.js";

test("a worker host that keeps failing to poll the journal waits twice as long each time, up to 30 s (#4768)", () => {
	let now = 0;
	const backoff = new HostPollBackoff(
		() => now,
		() => 0,
	);
	assert.equal(backoff.due(), true, "a host that never failed polls at once");
	const waits = Array.from({ length: 8 }, () => backoff.failed());
	assert.deepEqual(
		waits.map((wait) => wait.retryInMs),
		[1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000],
	);
	assert.deepEqual(
		waits.map((wait) => wait.failures),
		[1, 2, 3, 4, 5, 6, 7, 8],
	);
	assert.deepEqual(HOST_POLL_BACKOFF, { firstMs: 1_000, maxMs: 30_000 });
	now = 29_999;
	assert.equal(backoff.due(), false, "it waits out the last failure's wait");
	now = 30_000;
	assert.equal(backoff.due(), true);
	assert.equal(backoff.succeeded(), 8, "a poll that succeeds reports the failures before it");
	assert.equal(backoff.succeeded(), 0);
	assert.equal(backoff.failed().retryInMs, 1_000, "and the next failure waits as the first did");
});

test("jitter takes off up to half of a poll's wait, so hosts that failed together come back apart (#4768)", () => {
	const at = (random: number) =>
		new HostPollBackoff(
			() => 0,
			() => random,
			{ firstMs: 100, maxMs: 1_000 },
		);
	assert.equal(at(0).failed().retryInMs, 100);
	assert.equal(at(0.5).failed().retryInMs, 75);
	assert.equal(at(0.999).failed().retryInMs, 50);
});
