import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactorModel } from "@bastani/pi-ai";
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
const morph: CompactorModel = {
	type: "compactor",
	id: "morph-compactor",
	name: "Morph Compactor",
	api: "morph-compact",
	provider: "morph",
	baseUrl: "https://api.morphllm.com/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const region = createNumberedRegion(`[User]: task\n${Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n")}`);
const preparation = {
	firstKeptEntryId: "tail",
	region,
	regionEntryIds: [],
	keptTailMessageCount: 2,
	tokensBefore: region.tokenEstimate,
	parameters: { query: "task", compression_ratio: 0.5, preserve_recent: 2 },
	settings: DEFAULT_COMPACTION_SETTINGS,
};

test("Morph compaction resolution requires a registered compactor (#3470)", () => {
	assert.throws(() => resolveCompactionModel("morph/morph-compactor", model, []), /compactionModel/);
	assert.equal(resolveCompactionModel("morph/morph-compactor", model, [morph]).kind, "morph");
});

test("Morph rung one uses its own auth without invoking a chat model (#3470)", async () => {
	let requests = 0;
	const result = await runVerbatimCompaction(preparation, model, {
		compactionModel: { kind: "morph", fullId: "morph/morph-compactor" },
		resolveMorphApiKey: async () => "morph-secret",
		morphFetchFn: async () => {
			requests++;
			return Response.json({ messages: [{ compacted_line_ranges: [{ start: 2, end: 10 }] }] });
		},
		resolveAuth: async () => {
			assert.fail("must not authenticate session model");
		},
		streamFn: () => {
			assert.fail("must not invoke session model");
		},
		thinkingLevel: "off",
		urgency: "recoverable",
	});
	assert.equal(requests, 1);
	assert.equal(result.backend, "morph");
	assert.equal(result.model, "morph/morph-compactor");
	assert.equal(result.keptTail, true);
	assert.deepEqual(result.ranges, [{ start: 2, end: 10 }]);
});

test("Morph HTTP errors continue to configured chat fallback (#3470)", async () => {
	const fallback = { ...model, id: "fallback" };
	const calls: string[] = [];
	const stream = createFauxStreamFn(["1:2,10\n"]).streamFn;
	const result = await runVerbatimCompaction(preparation, model, {
		compactionModel: { kind: "morph", fullId: "morph/morph-compactor" },
		resolveMorphApiKey: async () => "key",
		morphFetchFn: async () => new Response("bad", { status: 503 }),
		resolveAuth: async (candidate) => {
			calls.push(candidate.id);
			return { apiKey: "fallback-key" };
		},
		streamFn: stream,
		thinkingLevel: "off",
		urgency: "recoverable",
		fallback: {
			fallbackModels: ["test/fallback"],
			registry: { getAvailableSnapshot: () => [fallback], getModel: () => fallback, hasConfiguredAuth: () => true },
			preferredProvider: "test",
			sessionThinkingLevel: "off",
		},
	});
	assert.deepEqual(calls, ["fallback"]);
	assert.equal(result.backend, "planner");
	assert.equal(result.model, "test/fallback");
});

test("Morph HTTP policy failures persist safe diagnostics before the ladder continues (#3470)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-morph-diagnostic-"));
	try {
		const fallback = { ...model, id: "fallback" };
		const result = await runVerbatimCompaction(preparation, model, {
			compactionModel: { kind: "morph", fullId: "morph/morph-compactor" },
			resolveMorphApiKey: async () => "morph-secret",
			morphFetchFn: async () => new Response('Content policy block; {"api_key":"morph-secret"}', { status: 403 }),
			resolveAuth: async () => ({ apiKey: "fallback-key" }),
			streamFn: createFauxStreamFn(["1:2,10\n"]).streamFn,
			thinkingLevel: "off",
			urgency: "recoverable",
			sessionFilePath: join(directory, "session.jsonl"),
			fallback: {
				fallbackModels: ["test/fallback"],
				registry: {
					getAvailableSnapshot: () => [fallback],
					getModel: () => fallback,
					hasConfiguredAuth: () => true,
				},
				preferredProvider: "test",
				sessionThinkingLevel: "off",
			},
		});
		assert.equal(result.backend, "planner");
		assert.equal(result.model, "test/fallback");
		const file = readdirSync(directory).find((name) => name.includes("-compaction-morph-"));
		assert.ok(file);
		const diagnostic = readFileSync(join(directory, file), "utf8");
		assert.match(diagnostic, /"failureCategory": "policy_refusal"/);
		assert.match(diagnostic, /Morph compaction HTTP 403: Content policy block/);
		assert.match(diagnostic, /\[redacted\]/);
		assert.doesNotMatch(diagnostic, /morph-secret|fallback-key/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
