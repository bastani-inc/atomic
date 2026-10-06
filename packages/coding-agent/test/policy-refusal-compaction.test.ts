import assert from "node:assert/strict";
import type { Api, Model } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { test } from "vitest";
import { preparePiSummaryCompaction, runPiSummaryFallback } from "../src/core/compaction/pi-summary-fallback.js";
import { classifyPlannerFailure, syntheticErrorResponse } from "../src/core/compaction/planner-outcome.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { planner } from "./compaction-planner-fixtures.js";
import { createFauxStreamFn } from "./test-harness.js";

test("classifies policy refusals before incidental 500 codes and usage limits (#3470)", () => {
	const model = { api: "anthropic-messages" as const, provider: "anthropic", id: "test" };
	for (const message of [
		"This request was blocked as it seems to violate Anthropic's Terms of Service. Request 500",
		"Usage policy violation: usage limit 500",
		"Blocked due to content policy",
		"acceptable use policy violation",
	]) {
		assert.equal(classifyPlannerFailure(syntheticErrorResponse(model, message), 200000), "policy_refusal");
	}
	assert.equal(
		classifyPlannerFailure(syntheticErrorResponse(model, "Internal server error 500"), 200000),
		"rate_limited",
	);
	assert.equal(classifyPlannerFailure(syntheticErrorResponse(model, "invalid request"), 200000), "provider_error");
});

const model: Model<Api> = {
	id: "same-model",
	name: "Same",
	provider: "test",
	api: "openai-responses",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function entry(id: string, message: AgentMessage): SessionEntry {
	const parentId = { old: null, turn: "old", prefix: "turn", tail: "prefix" }[id];
	return { type: "message", id, parentId: parentId ?? null, timestamp: new Date(0).toISOString(), message };
}
function history(): SessionEntry[] {
	return [
		entry("old", { role: "user", content: "history".repeat(100), timestamp: 0 }),
		entry("turn", { role: "user", content: "request", timestamp: 1 }),
		entry("prefix", {
			...syntheticErrorResponse(model, ""),
			stopReason: "stop",
			content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "auth.ts" } }],
		}),
		entry("tail", {
			...syntheticErrorResponse(model, ""),
			stopReason: "stop",
			content: [{ type: "text", text: "retained answer".repeat(20) }],
		}),
	];
}

test("pi fallback uses token cut points and a separate turn-prefix summary (#3470)", async () => {
	const entries = history();
	const settings = { reserveTokens: 1000, keepRecentTokens: 10 };
	const prepared = preparePiSummaryCompaction(entries, settings);
	assert.equal(prepared?.firstKeptEntryId, "tail");
	assert.equal(prepared?.messagesToSummarize.length, 1);
	assert.equal(prepared?.turnPrefixMessages.length, 2);
	const { streamFn, state } = createFauxStreamFn(["history summary", "prefix summary"]);
	const result = await runPiSummaryFallback(entries, settings, planner(model, "off"), { streamFn });
	assert.equal(state.callCount, 2);
	assert.match(result.summary, /history summary[\s\S]*Turn Context \(split turn\)[\s\S]*prefix summary/);
	assert.deepEqual(result.readFiles, ["auth.ts"]);
	assert.deepEqual(result.modifiedFiles, []);
	assert.match(result.summary, /<read-files>\nauth.ts\n<\/read-files>/);
	assert.match(JSON.stringify(state.contexts[0]), /structured context checkpoint summary/);
	assert.match(JSON.stringify(state.contexts[1]), /Context Needed to Continue/);
});

test("pi fallback does not retry a summary policy refusal containing 500 (#3470)", async () => {
	const { streamFn, state } = createFauxStreamFn([{ stopReason: "error", error: "Content policy block 500" }]);
	await assert.rejects(
		runPiSummaryFallback(history(), { reserveTokens: 1000, keepRecentTokens: 10 }, planner(model, "off"), {
			streamFn,
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		}),
		/Content policy block 500/,
	);
	assert.equal(state.callCount, 1);
});

test("pi fallback updates prior summaries and carries file tracking forward (#3470)", async () => {
	const entries = history();
	const previous: SessionEntry = {
		type: "compaction",
		id: "checkpoint",
		parentId: "tail",
		timestamp: new Date(0).toISOString(),
		summary: "previous checkpoint",
		firstKeptEntryId: "turn",
		tokensBefore: 500,
		details: {
			strategy: "verbatim-lines",
			backend: "summary",
			summary: { readFiles: ["old.ts"], modifiedFiles: ["changed.ts"] },
		},
	};
	entries.push(previous, {
		type: "message",
		id: "new",
		parentId: "checkpoint",
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: "latest request".repeat(50), timestamp: 2 },
	});
	const { streamFn, state } = createFauxStreamFn(["updated checkpoint"]);
	const result = await runPiSummaryFallback(
		entries,
		{ reserveTokens: 1000, keepRecentTokens: 10 },
		planner(model, "off", { apiKey: "borrowed-key", baseUrl: "https://credential.example" }),
		{
			streamFn: (requestModel, context, options) => {
				assert.equal(requestModel.id, model.id);
				assert.equal(requestModel.baseUrl, "https://credential.example");
				assert.equal(options?.apiKey, "borrowed-key");
				return streamFn(requestModel, context, options);
			},
		},
	);
	assert.equal(result.firstKeptEntryId, "new");
	assert.deepEqual(result.readFiles, ["auth.ts", "old.ts"]);
	assert.deepEqual(result.modifiedFiles, ["changed.ts"]);
	assert.match(
		JSON.stringify(state.contexts[0]),
		/previous-summary[\s\S]*previous checkpoint[\s\S]*Update the existing structured summary/,
	);
});

test("pi summary fallback rejects incomplete summaries (#3470)", async () => {
	for (const response of [{ text: "partial", stopReason: "length" as const }, { text: "" }]) {
		const { streamFn } = createFauxStreamFn([response]);
		await assert.rejects(
			runPiSummaryFallback(history(), { reserveTokens: 1000, keepRecentTokens: 10 }, planner(model, "off"), {
				streamFn,
			}),
			/incomplete|empty/,
		);
	}
});

test("pi summary includes the retained tail of a previous verbatim compaction (#3470)", () => {
	const entries = history();
	entries.push({
		type: "compaction",
		id: "checkpoint",
		parentId: "tail",
		timestamp: new Date(0).toISOString(),
		summary: "earlier retained lines",
		firstKeptEntryId: "turn",
		tokensBefore: 500,
		details: { strategy: "verbatim-lines", backend: "planner" },
	});
	entries.push({
		type: "message",
		id: "new",
		parentId: "checkpoint",
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: "new request".repeat(100), timestamp: 2 },
	});
	const prepared = preparePiSummaryCompaction(entries, { reserveTokens: 1000, keepRecentTokens: 10 });
	assert.equal(prepared?.firstKeptEntryId, "new");
	assert.equal(prepared?.messagesToSummarize.length, 3);
	assert.equal(prepared?.previousSummary, "earlier retained lines");
});

test("pi summary does not retry a thrown policy block with an incidental 500 (#3470)", async () => {
	let calls = 0;
	await assert.rejects(
		runPiSummaryFallback(history(), { reserveTokens: 1000, keepRecentTokens: 10 }, planner(model, "off"), {
			streamFn: () => {
				calls++;
				throw new Error("Content policy block 500");
			},
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		}),
		/Content policy block 500/,
	);
	assert.equal(calls, 1);
});
