import assert from "node:assert/strict";
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
		compactionModel: { kind: "classifier" as const, fullId: "typesafe/jev-latest" },
		streamFn: createFauxStreamFn(["1:1,5\n"]).streamFn,
		resolveAuth: async () => {
			assert.fail("unavailable backend must not authenticate the session model");
		},
		thinkingLevel: "off" as const,
	};
	await assert.rejects(
		runVerbatimCompaction(preparation, model, { ...request, urgency: "recoverable" }),
		/not yet available/,
	);
	const fresh = await runVerbatimCompaction(preparation, model, { ...request, urgency: "load_bearing" });
	assert.equal(fresh.rung, "fresh");
});
