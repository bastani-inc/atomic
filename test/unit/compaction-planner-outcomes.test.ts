/**
 * RFC §8 — Unit: outcome classification.
 *
 * Every `PlannerOutcome` variant from a synthetic response, including the
 * narrow reasoning-starvation fingerprint and the quota-vs-throttle split.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RetryCallbacks } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { planDeletedLineRanges } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import { borrowed, PARAMETERS, region, scriptedStream, testModel } from "./compaction-rung-support.js";

async function plan(script: Parameters<typeof scriptedStream>[0], callbacks?: RetryCallbacks) {
	const stream = scriptedStream(script);
	const outcome = await planDeletedLineRanges(region(), PARAMETERS, borrowed(testModel(), "high"), 30, {
		streamFn: stream.streamFn,
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
		...(callbacks ? { callbacks } : {}),
	});
	return { outcome, stream };
}

test("valid whole output produces ranked", async () => {
	const { outcome } = await plan({ default: [{ text: "1,10\n20,25\n" }] });
	assert.deepEqual(outcome, {
		kind: "ranked",
		ranges: [
			{ start: 1, end: 10 },
			{ start: 20, end: 25 },
		],
	});
});

test("a length stop with usable records produces recovered without retry", async () => {
	const { outcome, stream } = await plan({ default: [{ text: "1,10\n20,2", stopReason: "length" }] });
	assert.equal(outcome.kind, "recovered");
	assert.equal(stream.calls.length, 1);
	if (outcome.kind === "recovered") {
		assert.deepEqual(outcome.ranges, [{ start: 1, end: 10 }]);
		assert.equal(outcome.recoveredCount, 1);
	}
});

test("length + empty + reasoning tokens produces unusable/starved", async () => {
	const { outcome } = await plan({
		default: [{ text: "", stopReason: "length", usage: { output: 4096, reasoning: 4096 } }],
	});
	assert.deepEqual(outcome, { kind: "unusable", category: "starved", excerpt: "" });
});

test("length + empty + zero reasoning produces a different unusable category", async () => {
	const { outcome } = await plan({
		default: [{ text: "", stopReason: "length", usage: { output: 4096, reasoning: 0 } }],
	});
	assert.deepEqual(outcome, { kind: "unusable", category: "malformed_output", excerpt: "" });
});

test("a length stop whose records are all unusable is not starved without reasoning tokens", async () => {
	// Protected lines 1-60 leave no deletable line, so validation yields nothing.
	const stream = scriptedStream({ default: [{ text: "1,5\n", stopReason: "length" }] });
	const outcome = await planDeletedLineRanges(
		region(10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
		PARAMETERS,
		borrowed(testModel(), "high"),
		5,
		{ streamFn: stream.streamFn },
	);
	assert.deepEqual(outcome, { kind: "unusable", category: "no_usable_ranges", excerpt: "1,5\n" });
});

test("transient throttling after the retry budget produces rateLimited/exhausted", async () => {
	const scheduled: number[] = [];
	const { outcome, stream } = await plan(
		{ default: [{ errorMessage: "429 Too Many Requests" }] },
		{
			onRetryScheduled: (attempt: number) => {
				scheduled.push(attempt);
			},
		},
	);
	assert.equal(outcome.kind, "rateLimited");
	if (outcome.kind === "rateLimited") assert.equal(outcome.exhausted, true);
	// Backoff was genuinely spent: pi-ai retried the transient error.
	assert.deepEqual(scheduled, [1, 2]);
	assert.equal(stream.calls.length, 3);
});

test("quota exhaustion produces rateLimited/not-exhausted with zero backoff", async () => {
	const scheduled: number[] = [];
	const { outcome, stream } = await plan(
		{ default: [{ errorMessage: "insufficient_quota: you exceeded your current quota" }] },
		{
			onRetryScheduled: (attempt: number) => {
				scheduled.push(attempt);
			},
		},
	);
	assert.equal(outcome.kind, "rateLimited");
	if (outcome.kind === "rateLimited") {
		assert.equal(outcome.category, "quota");
		assert.equal(outcome.exhausted, false);
	}
	assert.deepEqual(scheduled, []);
	assert.equal(stream.calls.length, 1);
});

test("generic usage-limit wording is quota exhaustion, not spent backoff", async () => {
	// pi-ai lists `usage limit` in neither its retryable nor its non-retryable
	// pattern, so `retryAssistantCall` schedules nothing for it. Reporting
	// `exhausted: true` would claim a retry budget that was never spent.
	const scheduled: number[] = [];
	const { outcome, stream } = await plan(
		{ default: [{ errorMessage: "Codex error: The usage limit has been reached" }] },
		{
			onRetryScheduled: (attempt: number) => {
				scheduled.push(attempt);
			},
		},
	);
	assert.equal(outcome.kind, "rateLimited");
	if (outcome.kind === "rateLimited") {
		assert.equal(outcome.category, "quota");
		assert.equal(outcome.exhausted, false);
	}
	assert.deepEqual(scheduled, []);
	assert.equal(stream.calls.length, 1);
});

test("the sidecar records the quota/throttle split for a usage limit", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compaction-usage-limit-"));
	try {
		const sessionFilePath = join(directory, "session.jsonl");
		const stream = scriptedStream({ default: [{ errorMessage: "Monthly usage limit reached" }] });
		const outcome = await planDeletedLineRanges(region(), PARAMETERS, borrowed(testModel(), "high"), 30, {
			streamFn: stream.streamFn,
			sessionFilePath,
		});
		assert.equal(outcome.kind, "rateLimited");
		const written = readdirSync(directory).filter((name) => name.includes("compaction-diagnostic"));
		assert.equal(written.length, 1);
		const payload = JSON.parse(readFileSync(join(directory, written[0]), "utf-8")) as {
			failureCategory: string;
			rateLimitExhausted?: boolean;
		};
		// Quota is its own durable category, not a rate-limit record that happens
		// to report no spent backoff.
		assert.equal(payload.failureCategory, "quota");
		assert.equal(payload.rateLimitExhausted, false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a throttle that did spend backoff records rateLimitExhausted true", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compaction-throttle-"));
	try {
		const sessionFilePath = join(directory, "session.jsonl");
		const stream = scriptedStream({ default: [{ errorMessage: "429 Too Many Requests" }] });
		await planDeletedLineRanges(region(), PARAMETERS, borrowed(testModel(), "high"), 30, {
			streamFn: stream.streamFn,
			sessionFilePath,
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		const written = readdirSync(directory).filter((name) => name.includes("compaction-diagnostic"));
		const payload = JSON.parse(readFileSync(join(directory, written[0]), "utf-8")) as {
			failureCategory: string;
			rateLimitExhausted?: boolean;
		};
		assert.equal(payload.failureCategory, "rate_limited");
		assert.equal(payload.rateLimitExhausted, true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("context overflow is classified through isContextOverflow", async () => {
	const { outcome } = await plan({
		default: [{ errorMessage: "This model's maximum context length is 100000 tokens" }],
	});
	assert.deepEqual(outcome, { kind: "overflowed" });
});

test("any other provider error produces providerError", async () => {
	const { outcome } = await plan({ default: [{ errorMessage: "malformed tool schema" }] });
	assert.deepEqual(outcome, { kind: "providerError", message: "malformed tool schema" });
});

test("a thrown transport failure classifies without throwing", async () => {
	const { outcome } = await plan({ default: [{ throws: "socket hang up" }] });
	assert.deepEqual(outcome, { kind: "providerError", message: "socket hang up" });
});

test("a thrown throttle failure classifies as rate limiting with no backoff spent", async () => {
	// The stream threw before `retryAssistantCall` scheduled anything, so no
	// retry budget was consumed and `exhausted` must not claim otherwise.
	const { outcome } = await plan({ default: [{ throws: "429 too many requests" }] });
	assert.deepEqual(outcome, {
		kind: "rateLimited",
		category: "rate_limited",
		exhausted: false,
		message: "429 too many requests",
	});
});

test("cancellation still throws rather than producing an outcome", async () => {
	const controller = new AbortController();
	controller.abort();
	const stream = scriptedStream({ default: [{ text: "1,10\n" }] });
	await assert.rejects(
		() =>
			planDeletedLineRanges(region(), PARAMETERS, borrowed(testModel(), "high"), 30, {
				streamFn: stream.streamFn,
				signal: controller.signal,
			}),
		/Compaction cancelled/,
	);
});

test("a silent stop-shaped overflow is classified before its text is parsed", async () => {
	// pi-ai recognizes an ordinary `stop` whose input already exceeds the window.
	// The text even looks like valid deletion records; overflow must still win,
	// or the ladder never gets the chance to trim and retry the same model.
	const { outcome, stream } = await plan({
		default: [{ text: "1,10\n", stopReason: "stop", usage: { input: 200_000, cacheRead: 0 } }],
	});
	assert.equal(outcome.kind, "overflowed");
	assert.equal(stream.calls.length, 1);
});

test("a silent length-shaped overflow beats truncation recovery and starvation", async () => {
	// `length` with zero output and input at ~99% of the window is pi-ai's other
	// silent-overflow fingerprint. Recovery and the starved verdict must not
	// consume it first.
	const { outcome } = await plan({
		default: [
			{
				text: "1,10\n20,3",
				stopReason: "length",
				usage: { input: 99_500, cacheRead: 0, output: 0, reasoning: 0 },
			},
		],
	});
	assert.equal(outcome.kind, "overflowed");
});

test("the full explicit 5xx class is rate limiting, and neighbours are not", async () => {
	const cases: Array<[string, string]> = [
		["500 Internal Server Error", "rateLimited"],
		["501 Not Implemented", "rateLimited"],
		["599 Network Connect Timeout", "rateLimited"],
		["499 Client Closed Request", "providerError"],
		["600 nonsense status", "providerError"],
		["model 5000 is unavailable", "providerError"],
	];
	for (const [message, kind] of cases) {
		const { outcome } = await plan({ default: [{ errorMessage: message }] });
		assert.equal(outcome.kind, kind, `"${message}" classified as ${outcome.kind}`);
	}
});

test("exhausted is false when the retry budget was never spent", async () => {
	// Retry disabled: one 429 request schedules nothing.
	const stream = scriptedStream({ default: [{ errorMessage: "429 Too Many Requests" }] });
	const outcome = await planDeletedLineRanges(region(), PARAMETERS, borrowed(testModel(), "high"), 30, {
		streamFn: stream.streamFn,
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
	});
	assert.deepEqual(outcome, {
		kind: "rateLimited",
		category: "rate_limited",
		exhausted: false,
		message: "429 Too Many Requests",
	});
	assert.equal(stream.calls.length, 1);
});

test("exhausted is true only after a retry was actually scheduled", async () => {
	const scheduled: number[] = [];
	const { outcome, stream } = await plan(
		{ default: [{ errorMessage: "429 Too Many Requests" }] },
		{
			onRetryScheduled: (attempt: number) => {
				scheduled.push(attempt);
			},
		},
	);
	assert.equal(outcome.kind, "rateLimited");
	if (outcome.kind === "rateLimited") assert.equal(outcome.exhausted, true);
	assert.deepEqual(scheduled, [1, 2]);
	assert.equal(stream.calls.length, 3);
});

test("the observer forwards every retry callback unchanged", async () => {
	const lifecycle: string[] = [];
	await plan(
		{ default: [{ errorMessage: "429 Too Many Requests" }] },
		{
			onRetryScheduled: async (attempt: number, max: number, delayMs: number, message: string) => {
				lifecycle.push(`scheduled:${attempt}/${max}:${delayMs}:${message}`);
			},
			onRetryAttemptStart: async () => {
				lifecycle.push("start");
			},
			onRetryFinished: async (success: boolean) => {
				lifecycle.push(`finished:${success}`);
			},
		},
	);
	assert.deepEqual(lifecycle, [
		"scheduled:1/2:0:429 Too Many Requests",
		"start",
		"scheduled:2/2:0:429 Too Many Requests",
		"start",
		"finished:false",
	]);
});

test("the sidecar records the observed exhaustion, not an assumed one", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compaction-observed-exhaustion-"));
	try {
		const sessionFilePath = join(directory, "session.jsonl");
		const stream = scriptedStream({ default: [{ errorMessage: "429 Too Many Requests" }] });
		await planDeletedLineRanges(region(), PARAMETERS, borrowed(testModel(), "high"), 30, {
			streamFn: stream.streamFn,
			sessionFilePath,
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		});
		const written = readdirSync(directory).filter((name) => name.includes("compaction-diagnostic"));
		const record = JSON.parse(readFileSync(join(directory, written[0]), "utf-8")) as {
			rateLimitExhausted?: boolean;
		};
		assert.equal(record.rateLimitExhausted, false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
