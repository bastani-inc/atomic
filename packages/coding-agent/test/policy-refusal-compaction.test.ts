import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("pi summary and turn-prefix calls retry rate limits and 5xx with shared callbacks (#3470)", async () => {
	const { streamFn, state } = createFauxStreamFn([
		{ stopReason: "error", error: "429 Too Many Requests" },
		"history summary",
		{ stopReason: "error", error: "503 Service Unavailable" },
		"prefix summary",
	]);
	let usages = 0;
	let retries = 0;
	const result = await runPiSummaryFallback(
		history(),
		{ reserveTokens: 1000, keepRecentTokens: 10 },
		planner(model, "off"),
		{
			streamFn,
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
			onUsage: () => {
				usages++;
			},
			callbacks: {
				onRetryScheduled: () => {
					retries++;
				},
			},
		},
	);
	assert.equal(state.callCount, 4);
	assert.equal(usages, 4);
	assert.equal(retries, 2);
	assert.deepEqual(state.contexts[0], state.contexts[1]);
	assert.deepEqual(state.contexts[2], state.contexts[3]);
	assert.match(result.summary, /history summary[\s\S]*prefix summary/);
});

test("pi summary exhausted retries preserve private failure diagnostics (#3470)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-summary-diagnostics-"));
	try {
		const { streamFn, state } = createFauxStreamFn([
			{ stopReason: "error", error: "503 Service Unavailable" },
			{ stopReason: "error", error: "503 Service Unavailable" },
		]);
		await assert.rejects(
			runPiSummaryFallback(
				history(),
				{ reserveTokens: 1000, keepRecentTokens: 10 },
				planner(model, "off", { apiKey: "secret-key" }),
				{
					streamFn,
					sessionFilePath: join(directory, "session.jsonl"),
					retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
				},
			),
			/503/,
		);
		assert.equal(state.callCount, 2);
		const files = readdirSync(directory);
		assert.equal(files.length, 1);
		const filePath = join(directory, files[0]);
		const body = readFileSync(filePath, "utf8");
		assert.match(body, /rate_limited/);
		assert.match(body, /503 Service Unavailable/);
		assert.doesNotMatch(body, /secret-key/);
		if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("pi summary retries thrown transport failures but never thrown policy refusals (#3470)", async () => {
	const { streamFn, state } = createFauxStreamFn(["history summary", "prefix summary"]);
	let calls = 0;
	let retries = 0;
	const result = await runPiSummaryFallback(
		history(),
		{ reserveTokens: 1000, keepRecentTokens: 10 },
		planner(model, "off"),
		{
			streamFn: (candidate, context, options) => {
				if (++calls === 1) throw new Error("fetch failed: socket hang up");
				return streamFn(candidate, context, options);
			},
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			callbacks: {
				onRetryScheduled: () => {
					retries++;
				},
			},
		},
	);
	assert.equal(calls, 3);
	assert.equal(retries, 1);
	assert.equal(state.callCount, 2);
	assert.match(result.summary, /history summary[\s\S]*prefix summary/);
});

test("pi summary preserves upstream budgets and cache routing across recoverable retries (#3470)", async () => {
	const { streamFn } = createFauxStreamFn([{ error: "503 Service Unavailable" }, "history", "prefix"]);
	const routing: (string | undefined)[] = [];
	const budgets: (number | undefined)[] = [];
	await runPiSummaryFallback(history(), { reserveTokens: 1000, keepRecentTokens: 10 }, planner(model, "off"), {
		streamFn: (candidate, context, options) => {
			routing.push(options?.sessionId);
			budgets.push(options?.maxTokens);
			assert.equal(options?.cacheRetention, "none");
			return streamFn(candidate, context, options);
		},
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
	});
	assert.deepEqual(budgets, [800, 800, 500]);
	assert.ok(routing[0]);
	assert.equal(routing[0], routing[1]);
});

test("pi cut point keeps a trailing tool result with its assistant call and adjacent metadata (#3470)", () => {
	const entries = history().slice(0, 3);
	entries.splice(2, 0, {
		type: "thinking_level_change",
		id: "metadata",
		parentId: "turn",
		timestamp: new Date(0).toISOString(),
		thinkingLevel: "off",
	});
	const call = entries[3];
	call.parentId = "metadata";
	entries.push(
		entry("result", {
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "large result".repeat(100) }],
			isError: false,
			timestamp: 2,
		}),
	);
	entries[4].parentId = "prefix";
	const prepared = preparePiSummaryCompaction(entries, { reserveTokens: 1000, keepRecentTokens: 10 });
	assert.equal(prepared?.firstKeptEntryId, "metadata");
	assert.deepEqual(prepared?.messagesToSummarize, [entries[0].type === "message" ? entries[0].message : undefined]);
	assert.deepEqual(prepared?.turnPrefixMessages, [entries[1].type === "message" ? entries[1].message : undefined]);
});

test("pi summary serializes the conversation as text and caps both request budgets at model maxTokens (#3470)", async () => {
	const { streamFn, state } = createFauxStreamFn(["history", "prefix"]);
	const budgets: (number | undefined)[] = [];
	await runPiSummaryFallback(
		history(),
		{ reserveTokens: 10000, keepRecentTokens: 10 },
		planner({ ...model, maxTokens: 300 }, "off"),
		{
			streamFn: (candidate, context, options) => {
				budgets.push(options?.maxTokens);
				return streamFn(candidate, context, options);
			},
		},
	);
	assert.deepEqual(budgets, [300, 300]);
	const prompt = JSON.stringify(state.contexts[1]);
	assert.match(prompt, /\[User\]: request/);
	assert.match(prompt, /\[Assistant tool calls\]: read\(path=\\"auth.ts\\"\)/);
	assert.doesNotMatch(prompt, /retained answer/);
});

test("pi summary joins multiple summary text blocks with upstream newline separators (#3470)", async () => {
	const { streamFn } = createFauxStreamFn(["history", "prefix"]);
	const result = await runPiSummaryFallback(
		history(),
		{ reserveTokens: 1000, keepRecentTokens: 10 },
		planner(model, "off"),
		{
			streamFn: (candidate, context, options) => {
				const stream = streamFn(candidate, context, options);
				const result = stream.result.bind(stream);
				stream.result = async () => ({
					...(await result()),
					content: [
						{ type: "text", text: "section one" },
						{ type: "text", text: "section two" },
					],
				});
				return stream;
			},
		},
	);
	assert.match(result.summary, /^section one\nsection two\n\n---/);
	assert.match(result.summary, /Turn Context \(split turn\):\*\*\n\nsection one\nsection two/);
});

test("pi cut points count whitespace text but ignore provider fallback metadata like upstream (#3470)", () => {
	const whitespace = history().slice(0, 2);
	if (whitespace[1].type === "message")
		whitespace[1].message = { role: "user", content: " ".repeat(40), timestamp: 1 };
	assert.equal(
		preparePiSummaryCompaction(whitespace, { reserveTokens: 1000, keepRecentTokens: 10 })?.firstKeptEntryId,
		"turn",
	);
	const fallback = history();
	if (fallback[1].type === "message")
		fallback[1].message = { role: "user", content: "request".repeat(20), timestamp: 1 };
	if (fallback[2].type === "message")
		fallback[2].message = {
			...syntheticErrorResponse(model, ""),
			stopReason: "stop",
			content: [{ type: "fallback", fromModel: "provider/model".repeat(100), toModel: "next" }],
		};
	if (fallback[3].type === "message")
		fallback[3].message = {
			...syntheticErrorResponse(model, ""),
			stopReason: "stop",
			content: [{ type: "text", text: "x".repeat(40) }],
		};
	assert.equal(
		preparePiSummaryCompaction(fallback, { reserveTokens: 1000, keepRecentTokens: 20 })?.firstKeptEntryId,
		"turn",
	);
});

test("pi fallback keeps Atomic tokensBefore diagnostics separate from upstream whitespace tail accounting (#3470)", () => {
	const entries = history().slice(0, 2);
	if (entries[1].type === "message") entries[1].message = { role: "user", content: " ".repeat(40), timestamp: 1 };
	const prepared = preparePiSummaryCompaction(entries, { reserveTokens: 1000, keepRecentTokens: 10 });
	assert.equal(prepared?.tokensBefore, 175);
	assert.equal(prepared?.keptTailTokens, 10);
});
