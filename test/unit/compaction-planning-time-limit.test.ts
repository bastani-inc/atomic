/**
 * Automatic compaction gives model planning one wall-clock limit (#4198): planner
 * requests, retries, overflow trims, borrowed fallback models and the credential
 * waits in between all count against it, and a fresh rung reached that way says why.
 */

import assert from "node:assert/strict";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@bastani/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, test, vi } from "vitest";
import { runVerbatimCompaction } from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import type { PlannerAuth } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { preparation, registryOf, runRequest, testModel } from "./compaction-rung-support.js";

/** The planning limit these tests use; the setting's default is minutes. */
const PLANNING_TIME_LIMIT_MS = 100;
/** Generous bound for a run that the limit should end within milliseconds. */
const SETTLE_BOUND_MS = 5_000;
/** Longer than the settle bound, so a wait the limit fails to cut is visible. */
const SLOW_AUTH_MS = 8_000;

const primary = testModel();
const backup = testModel({ provider: "backup", id: "planner-b", baseUrl: "https://backup.example" });
const spare = testModel({ provider: "spare", id: "planner-c", baseUrl: "https://spare.example" });

function fallbackContext(models: Model<Api>[]) {
	return {
		fallbackModels: models.map((model) => `${model.provider}/${model.id}`),
		registry: registryOf([primary, ...models]),
		preferredProvider: "primary",
		sessionThinkingLevel: "high" as const,
	};
}

function message(model: Model<Api>, fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	} as AssistantMessage;
}

/**
 * Planner whose requests to `hangOn` models never finish on their own (they settle only
 * when aborted); every other model answers with `others`. `first`, when given, answers
 * the very first request whatever its model.
 */
function planner(hangOn: string[], others: Partial<AssistantMessage>, first?: Partial<AssistantMessage>) {
	const calls: string[] = [];
	let aborted = 0;
	const streamFn = ((model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
		calls.push(model.id);
		if (first && calls.length === 1) return { result: () => Promise.resolve(message(model, first)) };
		return {
			result: () =>
				hangOn.includes(model.id)
					? new Promise<AssistantMessage>((resolve) => {
							const abort = () => {
								aborted += 1;
								resolve(message(model, { stopReason: "aborted" }));
							};
							if (options?.signal?.aborted) abort();
							else options?.signal?.addEventListener("abort", abort, { once: true });
						})
					: Promise.resolve(message(model, others)),
		};
	}) as unknown as StreamFn;
	return { streamFn, calls, aborted: () => aborted };
}

async function timed<T>(run: Promise<T>): Promise<{ value: T; elapsedMs: number } | "pending"> {
	const started = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run.then((value) => ({ value, elapsedMs: Date.now() - started })),
			new Promise<"pending">((resolve) => {
				timer = setTimeout(() => resolve("pending"), SETTLE_BOUND_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

afterEach(() => {
	vi.useRealTimers();
});

test("credential resolution counts against the planning time limit for the primary and every fallback (#4198)", async () => {
	const stream = planner([], { stopReason: "error", errorMessage: "429 Too Many Requests" });
	const signals: Array<AbortSignal | undefined> = [];
	const resolveAuth = (_model: Model<Api>, signal?: AbortSignal) =>
		new Promise<PlannerAuth | undefined>((resolve) => {
			signals.push(signal);
			// Ignores its signal on purpose: the limit must hold even for an uncooperative resolver.
			setTimeout(() => resolve({ apiKey: "key" }), SLOW_AUTH_MS);
		});

	const run = await timed(
		runVerbatimCompaction(
			preparation(),
			primary,
			runRequest({
				streamFn: stream.streamFn,
				resolveAuth,
				fallback: fallbackContext([backup, spare]),
				urgency: "load_bearing",
				planningTimeoutMs: PLANNING_TIME_LIMIT_MS,
			}),
		),
	);

	assert.ok(run !== "pending", "a slow credential wait must not outlast the planning time limit");
	assert.equal(run.value.rung, "fresh");
	assert.equal(run.value.freshReason, `Compaction planning timed out after ${PLANNING_TIME_LIMIT_MS} ms`);
	assert.deepEqual(stream.calls, [], "no planner request is sent once the limit has run out");
	assert.ok(signals.length > 0 && signals.every((signal) => signal?.aborted === true));
});

test("once the limit runs out inside a fallback's credential lookup, no later fallback's lookup starts (#4198)", async () => {
	const stream = planner([], { stopReason: "error", errorMessage: "429 Too Many Requests" });
	const looked: string[] = [];
	const resolveAuth = (model: Model<Api>) => {
		looked.push(model.id);
		if (model.id !== backup.id) return Promise.resolve<PlannerAuth | undefined>({ apiKey: "key" });
		// The backup's lookup ignores its signal and outlasts the limit.
		return new Promise<PlannerAuth | undefined>((resolve) => {
			setTimeout(() => resolve({ apiKey: "key" }), SLOW_AUTH_MS);
		});
	};

	const run = await timed(
		runVerbatimCompaction(
			preparation(),
			primary,
			runRequest({
				streamFn: stream.streamFn,
				resolveAuth,
				fallback: fallbackContext([backup, spare]),
				urgency: "load_bearing",
				planningTimeoutMs: PLANNING_TIME_LIMIT_MS,
			}),
		),
	);

	assert.ok(run !== "pending");
	assert.equal(run.value.rung, "fresh");
	assert.deepEqual(stream.calls, ["planner-a"], "only the primary planner was asked");
	assert.deepEqual(looked, ["planner-a", "planner-b"], "the spare's credentials were never looked up");
});

test("cancelling during a slow credential lookup cancels promptly instead of reaching the fresh rung (#4198)", async () => {
	const stream = planner([], { stopReason: "error", errorMessage: "429 Too Many Requests" });
	const controller = new AbortController();
	const resolveAuth = () =>
		new Promise<PlannerAuth | undefined>((resolve) => {
			setTimeout(() => resolve({ apiKey: "key" }), SLOW_AUTH_MS);
		});
	const run = runVerbatimCompaction(
		preparation(),
		primary,
		runRequest({
			streamFn: stream.streamFn,
			resolveAuth,
			fallback: fallbackContext([backup]),
			urgency: "load_bearing",
			signal: controller.signal,
			planningTimeoutMs: 60_000,
		}),
	);
	setTimeout(() => controller.abort(), 20);
	const outcome = await timed(
		run.then(
			() => "completed" as const,
			(error: Error) => error.message,
		),
	);

	assert.ok(outcome !== "pending", "cancellation must not wait for the credential lookup");
	assert.equal(outcome.value, "Compaction cancelled");
	assert.deepEqual(stream.calls, []);
});

test("the planning time limit spans overflow trims: an overflow then a trimmed request that never finishes (#4198)", async () => {
	const stream = planner(
		[primary.id],
		{},
		{ stopReason: "error", errorMessage: "prompt is too long: context_length_exceeded" },
	);
	const streamFn = stream.streamFn;

	const run = await timed(
		runVerbatimCompaction(
			preparation(),
			primary,
			runRequest({ streamFn, urgency: "load_bearing", planningTimeoutMs: PLANNING_TIME_LIMIT_MS }),
		),
	);

	assert.ok(run !== "pending");
	assert.equal(stream.calls.length, 2, "the overflow was trimmed and retried on the same model once");
	assert.equal(stream.aborted(), 1);
	assert.equal(run.value.rung, "fresh");
	assert.match(run.value.freshReason ?? "", /timed out after 100 ms/);
});

test("the planning time limit ends a borrowed fallback model's request that never finishes (#4198)", async () => {
	const stream = planner(["planner-b"], { stopReason: "error", errorMessage: "429 Too Many Requests" });

	const run = await timed(
		runVerbatimCompaction(
			preparation(),
			primary,
			runRequest({
				streamFn: stream.streamFn,
				fallback: fallbackContext([backup, spare]),
				urgency: "load_bearing",
				planningTimeoutMs: PLANNING_TIME_LIMIT_MS,
			}),
		),
	);

	assert.ok(run !== "pending");
	assert.deepEqual(stream.calls, ["planner-a", "planner-b"], "no further fallback is borrowed after the limit");
	assert.equal(stream.aborted(), 1);
	assert.equal(run.value.rung, "fresh");
	assert.match(run.value.freshReason ?? "", /timed out after 100 ms/);
});

test("a fresh rung records why planning failed even without a time limit (#4198)", async () => {
	const stream = planner([], { stopReason: "error", errorMessage: "429 Too Many Requests" });
	const result = await runVerbatimCompaction(
		preparation(),
		primary,
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);
	assert.equal(result.rung, "fresh");
	assert.match(result.freshReason ?? "", /429 Too Many Requests/);
});

test("a planning time limit beyond the platform timer maximum fires exactly at the limit, not at the clamp (#4198)", async () => {
	vi.useFakeTimers();
	const limitMs = 3_000_000_000;
	const platformTimerMaxMs = 2_147_483_647;
	const stream = planner(["planner-a"], {});
	const run = runVerbatimCompaction(
		preparation(),
		primary,
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing", planningTimeoutMs: limitMs }),
	);
	let settled = false;
	void run.then(() => {
		settled = true;
	});

	await vi.advanceTimersByTimeAsync(platformTimerMaxMs + 1_000);
	assert.equal(settled, false, "the limit must not fire at the platform timer maximum");
	assert.equal(stream.aborted(), 0);

	await vi.advanceTimersByTimeAsync(limitMs - (platformTimerMaxMs + 1_000) - 1);
	assert.equal(settled, false, "the limit must not fire before it is reached");

	await vi.advanceTimersByTimeAsync(1);
	assert.equal(settled, true, "the limit fires once it is reached");
	assert.equal((await run).freshReason, `Compaction planning timed out after ${limitMs} ms`);
});
