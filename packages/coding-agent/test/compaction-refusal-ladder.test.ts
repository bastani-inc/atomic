import assert from "node:assert/strict";
import type { Api, Model } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { runVerbatimCompaction } from "../src/core/compaction/compaction-runner.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { createFauxStreamFn } from "./test-harness.js";

const model: Model<Api> = {
	id: "primary",
	name: "Primary",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
};
const fallback = { ...model, id: "fallback" };
const region = createNumberedRegion(Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n"));
const preparation = {
	firstKeptEntryId: "tail",
	region,
	regionEntryIds: ["old"],
	keptTailMessageCount: 0,
	tokensBefore: region.tokenEstimate,
	parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "continue" },
	settings: DEFAULT_COMPACTION_SETTINGS,
};
const timestamp = new Date(0).toISOString();
const summaryEntries: SessionEntry[] = [
	{
		type: "message",
		id: "old",
		parentId: null,
		timestamp,
		message: { role: "user", content: "history", timestamp: 0 },
	},
	{
		type: "message",
		id: "tail",
		parentId: "old",
		timestamp,
		message: { role: "user", content: "recent".repeat(20000), timestamp: 1 },
	},
];

function fallbackContext() {
	return {
		fallbackModels: ["test/fallback"],
		preferredProvider: "test",
		sessionThinkingLevel: "off" as const,
		registry: {
			getAvailableSnapshot: () => [model, fallback],
			getModel: (provider: string, id: string) =>
				[model, fallback].find((candidate) => candidate.provider === provider && candidate.id === id),
			hasConfiguredAuth: () => true,
		},
	};
}

test("policy refusal containing 500 goes to pi summary on the same model without 5xx retries (#3470)", async () => {
	const calls: string[] = [];
	const { streamFn, state } = createFauxStreamFn([
		{ stopReason: "error", error: "Content policy block 500" },
		"checkpoint",
	]);
	const result = await runVerbatimCompaction(preparation, model, {
		streamFn: (candidate, context, options) => {
			calls.push(candidate.id);
			return streamFn(candidate, context, options);
		},
		summaryEntries,
		resolveAuth: async () => ({ apiKey: "key" }),
		thinkingLevel: "off",
		urgency: "recoverable",
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		fallback: fallbackContext(),
	});
	assert.deepEqual(calls, ["primary", "primary"]);
	assert.equal(state.callCount, 2);
	assert.equal(result.backend, "summary");
	assert.equal(result.model, "test/primary");
	assert.equal(result.summaryFirstKeptEntryId, "tail");
	assert.match(JSON.stringify(state.contexts[1]), /structured context checkpoint summary/);
});

test("pi summary refusal continues to the borrowed planner and never changes its model (#3470)", async () => {
	const calls: string[] = [];
	const { streamFn } = createFauxStreamFn([
		{ stopReason: "error", error: "Content policy block" },
		{ stopReason: "error", error: "Usage policy violation 500" },
		"1:1,5",
	]);
	const result = await runVerbatimCompaction(preparation, model, {
		streamFn: (candidate, context, options) => {
			calls.push(candidate.id);
			return streamFn(candidate, context, options);
		},
		summaryEntries,
		resolveAuth: async () => ({ apiKey: "key" }),
		thinkingLevel: "off",
		urgency: "recoverable",
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		fallback: fallbackContext(),
	});
	assert.deepEqual(calls, ["primary", "primary", "fallback"]);
	assert.equal(result.backend, "planner");
	assert.equal(result.model, "test/fallback");
});

test("non-refusal errors bypass pi summary and keep the existing ladder (#3470)", async () => {
	const calls: string[] = [];
	const { streamFn, state } = createFauxStreamFn([{ stopReason: "error", error: "Invalid request" }, "1:1,5"]);
	const result = await runVerbatimCompaction(preparation, model, {
		streamFn: (candidate, context, options) => {
			calls.push(candidate.id);
			return streamFn(candidate, context, options);
		},
		summaryEntries,
		resolveAuth: async () => ({ apiKey: "key" }),
		thinkingLevel: "off",
		urgency: "recoverable",
		fallback: fallbackContext(),
	});
	assert.deepEqual(calls, ["primary", "fallback"]);
	assert.equal(result.backend, "planner");
	assert.doesNotMatch(JSON.stringify(state.contexts[1]), /structured context checkpoint summary/);
});

test("classifier and Morph policy refusals skip pi summary and advance directly to chat fallback (#3470)", async () => {
	for (const kind of ["classifier", "morph"] as const) {
		const calls: string[] = [];
		const { streamFn, state } = createFauxStreamFn(["1:1,5"]);
		const result = await runVerbatimCompaction(preparation, model, {
			compactionModel:
				kind === "morph"
					? { kind, fullId: "morph/morph-compactor" }
					: {
							kind,
							fullId: "typesafe/jev-latest",
							model: {
								...model,
								type: "classifier",
								api: "typesafe-system-one",
								provider: "typesafe",
								id: "jev-latest",
							},
						},
			classify: async () => ({
				api: "typesafe-system-one",
				provider: "typesafe",
				model: "jev-latest",
				answers: {},
				stopReason: "error",
				errorMessage: "Content policy block 500",
				timestamp: 0,
			}),
			resolveMorphApiKey: async () => "morph-key",
			morphFetchFn: async () => new Response("Content policy block 500", { status: 403 }),
			streamFn: (candidate, context, options) => {
				calls.push(candidate.id);
				return streamFn(candidate, context, options);
			},
			summaryEntries,
			resolveAuth: async () => ({ apiKey: "fallback-key" }),
			thinkingLevel: "off",
			urgency: "recoverable",
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
			fallback: fallbackContext(),
		});
		assert.deepEqual(calls, ["fallback"]);
		assert.equal(state.callCount, 1);
		assert.equal(result.backend, "planner");
		assert.equal(result.model, "test/fallback");
		assert.doesNotMatch(JSON.stringify(state.contexts[0]), /structured context checkpoint summary/);
	}
});

for (const rung of ["explicit", "borrowed"] as const) {
	test(`${rung} chat compaction model native refusal uses pi summary on that model (#3470)`, async () => {
		const calls: string[] = [];
		const { streamFn, state } = createFauxStreamFn(
			rung === "borrowed" ? ["invalid", "refused", "checkpoint"] : ["refused", "checkpoint"],
		);
		const result = await runVerbatimCompaction(preparation, model, {
			compactionModel: rung === "explicit" ? { kind: "chat", fullId: "test/fallback", model: fallback } : undefined,
			streamFn: (candidate, context, options) => {
				calls.push(candidate.id);
				const stream = streamFn(candidate, context, options);
				const call = calls.length;
				const result = stream.result.bind(stream);
				stream.result = async () => ({
					...(await result()),
					...(call === (rung === "borrowed" ? 2 : 1) ? { rawStopReason: "refusal" } : {}),
				});
				return stream;
			},
			summaryEntries,
			resolveAuth: async () => ({ apiKey: "key" }),
			thinkingLevel: "off",
			urgency: "recoverable",
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
			fallback: fallbackContext(),
		});
		assert.deepEqual(calls, rung === "explicit" ? ["fallback", "fallback"] : ["primary", "fallback", "fallback"]);
		assert.equal(result.backend, "summary");
		assert.equal(result.model, "test/fallback");
		assert.match(JSON.stringify(state.contexts.at(-1)), /structured context checkpoint summary/);
	});
}
