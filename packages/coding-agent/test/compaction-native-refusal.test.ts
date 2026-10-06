import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { runVerbatimCompaction } from "../src/core/compaction/compaction-runner.js";
import { classifyPlannerFailure, syntheticErrorResponse } from "../src/core/compaction/planner-outcome.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { createFauxStreamFn, fauxModel as FAUX_MODEL } from "./test-harness.js";

const region = createNumberedRegion(Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n"));
const entries: SessionEntry[] = ["old", "tail"].map((id, index) => ({
	type: "message",
	id,
	parentId: index ? "old" : null,
	timestamp: new Date(0).toISOString(),
	message: { role: "user", content: index ? "recent".repeat(20000) : "unique older context", timestamp: index },
}));

for (const native of [
	{ rawStopReason: "refusal", stopReason: "error" as const, errorMessage: "request 500" },
	{ stopReason: "error" as const, errorMessage: "The model refused to complete the request" },
	{ rawStopReason: "refusal", stopReason: "stop" as const },
]) {
	test(`native refusal ${JSON.stringify(native)} uses same-model summary before the ladder (#3470)`, async () => {
		const response: AssistantMessage = { ...syntheticErrorResponse(FAUX_MODEL, ""), ...native };
		assert.equal(classifyPlannerFailure(response, 200000), "policy_refusal");
		const { streamFn, state } = createFauxStreamFn(["refused", "checkpoint"]);
		const calls: string[] = [];
		const result = await runVerbatimCompaction(
			{
				firstKeptEntryId: "tail",
				region,
				regionEntryIds: ["old"],
				keptTailMessageCount: 0,
				tokensBefore: region.tokenEstimate,
				parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "continue" },
				settings: DEFAULT_COMPACTION_SETTINGS,
			},
			FAUX_MODEL,
			{
				streamFn: (model, context, options) => {
					calls.push(model.id);
					const stream = streamFn(model, context, options);
					if (calls.length === 1) {
						const result = stream.result.bind(stream);
						stream.result = async () => ({ ...(await result()), ...native });
					}
					return stream;
				},
				summaryEntries: entries,
				resolveAuth: async () => ({ apiKey: "key" }),
				thinkingLevel: "off",
				urgency: "recoverable",
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
			},
		);
		assert.deepEqual(calls, [FAUX_MODEL.id, FAUX_MODEL.id]);
		assert.equal(result.backend, "summary");
		assert.equal(state.callCount, 2);
	});
}

test("native refusal text cannot become a summary checkpoint and advances the ladder without retry (#3470)", async () => {
	const fallback = { ...FAUX_MODEL, id: "fallback" };
	const { streamFn } = createFauxStreamFn(["refusal", "I cannot help with that request. 500", "1:1,5"]);
	const calls: string[] = [];
	const result = await runVerbatimCompaction(
		{
			firstKeptEntryId: "tail",
			region,
			regionEntryIds: ["old"],
			keptTailMessageCount: 0,
			tokensBefore: region.tokenEstimate,
			parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "continue" },
			settings: DEFAULT_COMPACTION_SETTINGS,
		},
		FAUX_MODEL,
		{
			streamFn: (model, context, options) => {
				calls.push(model.id);
				const stream = streamFn(model, context, options);
				if (calls.length <= 2) {
					const result = stream.result.bind(stream);
					stream.result = async () => ({ ...(await result()), rawStopReason: "refusal" });
				}
				return stream;
			},
			summaryEntries: entries,
			resolveAuth: async () => ({ apiKey: "key" }),
			thinkingLevel: "off",
			urgency: "recoverable",
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
			fallback: {
				fallbackModels: [`${fallback.provider}/${fallback.id}`],
				preferredProvider: fallback.provider,
				sessionThinkingLevel: "off",
				registry: {
					getAvailableSnapshot: () => [FAUX_MODEL, fallback],
					getModel: (_provider, id) => (id === fallback.id ? fallback : FAUX_MODEL),
					hasConfiguredAuth: () => true,
				},
			},
		},
	);
	assert.deepEqual(calls, [FAUX_MODEL.id, FAUX_MODEL.id, "fallback"]);
	assert.equal(result.backend, "planner");
});
