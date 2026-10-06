import assert from "node:assert/strict";
import type { ClassifierModel } from "@bastani/pi-ai";
import type { Api, Model } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { runVerbatimCompaction } from "../src/core/compaction/compaction-runner.js";
import { resolveCompactionModel } from "../src/core/compaction/model-resolver.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";
import { createFauxStreamFn } from "./test-harness.js";

const model: Model<Api> = {
	id: "session",
	name: "Session",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};
const selected = { ...model, id: "selected" };
const fallback = { ...model, id: "fallback" };
const classifier: ClassifierModel<"typesafe-system-one"> = {
	...model,
	api: "typesafe-system-one",
	type: "classifier",
	provider: "typesafe",
	id: "jev-latest",
};

test("selected compaction chat model is rung one and duplicate fallback is skipped (#3470)", async () => {
	const calls: string[] = [];
	const { streamFn: stream } = createFauxStreamFn(["unusable", "1:2,6\n"]);
	const region = createNumberedRegion(
		`[User]: objective\n${Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n")}`,
	);
	const result = await runVerbatimCompaction(
		{
			firstKeptEntryId: "tail",
			region,
			regionEntryIds: [],
			keptTailMessageCount: 0,
			tokensBefore: region.tokenEstimate,
			parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "objective" },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		model,
		{
			compactionModel: { kind: "chat", fullId: "test/selected", model: selected },
			streamFn: (candidate, context, options) => {
				calls.push(candidate.id);
				return stream(candidate, context, options);
			},
			resolveAuth: async () => ({ apiKey: "key" }),
			thinkingLevel: "off",
			urgency: "recoverable",
			fallback: {
				fallbackModels: ["test/selected:xhigh", "test/fallback"],
				registry: {
					getAvailableSnapshot: () => [model, selected, fallback],
					getModel: (provider, id) =>
						[model, selected, fallback].find(
							(candidate) => candidate.provider === provider && candidate.id === id,
						),
					hasConfiguredAuth: () => true,
				},
				preferredProvider: "test",
				sessionThinkingLevel: "off",
			},
		},
	);
	assert.deepEqual(calls, ["selected", "fallback"]);
	assert.equal(result.backend, "planner");
	assert.equal(result.model, "test/fallback");
});

test("compaction model resolution preserves auto and exact chat identity (#3470)", () => {
	assert.equal(resolveCompactionModel("auto", model, [model]).model, model);
	assert.equal(resolveCompactionModel("test/selected", model, [selected]).model, selected);
	assert.throws(() => resolveCompactionModel("test/missing", model, [selected]), /compactionModel/);
});

test("unavailable non-chat compactor fails manual compaction but permits load-bearing fresh (#3470)", async () => {
	const region = createNumberedRegion(Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n"));
	const preparation = {
		firstKeptEntryId: "tail",
		region,
		regionEntryIds: [],
		keptTailMessageCount: 0,
		tokensBefore: region.tokenEstimate,
		parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "objective" },
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
	const request = {
		compactionModel: { kind: "classifier" as const, fullId: "typesafe/jev-latest", model: classifier },
		streamFn: createFauxStreamFn(["1:1,5\n"]).streamFn,
		resolveAuth: async () => {
			assert.fail("unavailable backend must not authenticate the session model");
		},
		thinkingLevel: "off" as const,
	};
	await assert.rejects(
		runVerbatimCompaction(preparation, model, { ...request, urgency: "recoverable" }),
		/classifier is unavailable/,
	);
	const fresh = await runVerbatimCompaction(preparation, model, { ...request, urgency: "load_bearing" });
	assert.equal(fresh.rung, "fresh");
});

test("classifier resolution and rung one preserve protected context and the tail (#3470)", async () => {
	const selection = resolveCompactionModel("typesafe/jev-latest", model, [classifier]);
	assert.equal(selection.kind, "classifier");
	const region = createNumberedRegion(`[User]: task\n${Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n")}`);
	region.protectedLineNumbers = new Set([5]);
	const result = await runVerbatimCompaction(
		{
			firstKeptEntryId: "tail",
			region,
			regionEntryIds: [],
			keptTailMessageCount: 2,
			tokensBefore: 100,
			parameters: { query: "task", compression_ratio: 0.5, preserve_recent: 2 },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		model,
		{
			compactionModel: selection,
			classify: async (candidate, context) => {
				assert.equal(candidate, classifier);
				assert.ok(!JSON.stringify(context.state).includes("line 3"));
				return {
					api: "typesafe-system-one",
					provider: "typesafe",
					model: "jev-latest",
					answers: { score: { type: "score", score: 0, confidence: 1 } },
					stopReason: "stop",
					timestamp: 0,
				};
			},
			streamFn: () => assert.fail("chat planner must not run"),
			resolveAuth: async () => assert.fail("session authentication must not run"),
			thinkingLevel: "off",
			urgency: "recoverable",
		},
	);
	assert.equal(result.backend, "classifier");
	assert.equal(result.model, "typesafe/jev-latest");
	assert.equal(result.keptTail, true);
	assert.ok(result.text.includes("line 3"));
});

test("failed classifier falls through to a borrowed chat planner without partial deletions (#3470)", async () => {
	const region = createNumberedRegion(Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n"));
	const preparation = {
		firstKeptEntryId: "tail",
		region,
		regionEntryIds: [],
		keptTailMessageCount: 0,
		tokensBefore: 100,
		parameters: { query: "task", compression_ratio: 0.5, preserve_recent: 0 },
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
	const { streamFn } = createFauxStreamFn(["1:2,6\n"]);
	const result = await runVerbatimCompaction(preparation, model, {
		compactionModel: { kind: "classifier", fullId: "typesafe/jev-latest", model: classifier },
		classify: async () => {
			throw new Error("classify failed");
		},
		streamFn,
		resolveAuth: async () => ({ apiKey: "fake" }),
		thinkingLevel: "off",
		urgency: "recoverable",
		fallback: {
			fallbackModels: ["test/fallback"],
			registry: { getAvailableSnapshot: () => [fallback], getModel: () => fallback, hasConfiguredAuth: () => true },
			preferredProvider: "test",
			sessionThinkingLevel: "off",
		},
	});
	assert.equal(result.backend, "planner");
	assert.equal(result.model, "test/fallback");
	assert.deepEqual(result.ranges, [{ start: 2, end: 6 }]);
});
