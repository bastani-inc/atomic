import assert from "node:assert/strict";
import type { Context } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { prepareCompactionBoundary } from "../src/core/compaction/compaction-boundary.js";
import { preparePiSummaryCompaction, runVerbatimCompaction } from "../src/core/compaction/index.js";
import { generateSessionSummary } from "../src/core/compaction/session-summarization.js";
import { convertToLlm, toolBatchCutStart } from "../src/core/messages.js";
import { buildSessionContext, type SessionEntry, sessionEntryToContextMessages } from "../src/core/session-manager.js";
import { createFauxStreamFn, fauxModel } from "./test-harness.js";

const timestamp = new Date(0).toISOString();
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const INTERRUPTED = /interrupted after it started/;

type Turn =
	| ["user", string]
	| ["assistant", string]
	| ["calls", string, string[]]
	| ["result", string, string]
	| ["intercom", string];

function session(turns: Turn[]): SessionEntry[] {
	return turns.map((turn, index) => {
		const base = { type: "message", id: `e${index}`, parentId: index ? `e${index - 1}` : null, timestamp } as const;
		const assistant = {
			api: fauxModel.api,
			provider: fauxModel.provider,
			model: fauxModel.id,
			usage,
			timestamp: index,
		};
		switch (turn[0]) {
			case "user":
				return { ...base, message: { role: "user", content: turn[1], timestamp: index } };
			case "assistant":
				return {
					...base,
					message: {
						role: "assistant",
						content: [{ type: "text", text: turn[1] }],
						stopReason: "stop",
						...assistant,
					},
				};
			case "calls":
				return {
					...base,
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: turn[1] },
							...turn[2].map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } })),
						],
						stopReason: "toolUse",
						...assistant,
					},
				};
			case "intercom":
				return { ...base, type: "custom_message", customType: "intercom", content: turn[1], display: true };
			default:
				return {
					...base,
					message: {
						role: "toolResult",
						toolCallId: turn[1],
						toolName: "read",
						content: [{ type: "text", text: turn[2] }],
						isError: false,
						timestamp: index,
					},
				};
		}
	}) as SessionEntry[];
}

const filler = (lines: number, tag: string) =>
	Array.from({ length: lines }, (_, k) => `${tag} detail line ${k} ${"x".repeat(60)}`).join("\n");

function olderTurns(count = 6): Turn[] {
	const turns: Turn[] = [["user", "Please fix the parser"]];
	for (let index = 0; index < count; index++)
		turns.push(["assistant", filler(10, `t${index}`)], ["user", `next ${index}`]);
	return turns;
}

/** A parallel read of a and b, with an Intercom message admitted between the two results. */
const MID_BATCH: Turn[] = [
	["user", "read a and b"],
	["calls", "reading both files", ["toolu_a", "toolu_b"]],
	["result", "toolu_a", "CONTENT_OF_A"],
	["intercom", "message from peer"],
	["result", "toolu_b", "CONTENT_OF_B"],
];

function compactedAt(path: SessionEntry[], firstKeptEntryId: string | null): SessionEntry[] {
	return [
		...path,
		{
			type: "compaction",
			id: "k1",
			parentId: path.at(-1)?.id ?? null,
			timestamp,
			summary: "[User]: older questions",
			firstKeptEntryId,
			tokensBefore: 10,
			details: {
				strategy: "verbatim-lines",
				promptVersion: 2,
				parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "" },
				stats: {
					linesBefore: 1,
					linesDeleted: 0,
					linesKept: 1,
					rangeCount: 0,
					tokensBefore: 1,
					tokensAfter: 1,
					percentReduction: 0,
				},
				rung: "standard",
			},
		} as SessionEntry,
	];
}

function requestText(entries: SessionEntry[]): string {
	return JSON.stringify(convertToLlm(buildSessionContext(entries).messages));
}

function assertBothResults(text: string, where: string): void {
	assert.ok(text.includes("CONTENT_OF_A"), `${where} keeps the first result`);
	assert.ok(text.includes("CONTENT_OF_B"), `${where} keeps the second result`);
	assert.doesNotMatch(text, INTERRUPTED, `${where} invents no interrupted result`);
}

test("a verbatim cut right after a parallel batch keeps both results in the request (#5062)", () => {
	const path = session([
		...olderTurns(),
		["user", "check both files"],
		["calls", "reading both files", ["toolu_a", "toolu_b"]],
		["result", "toolu_a", "CONTENT_OF_A"],
		["result", "toolu_b", "CONTENT_OF_B"],
	]);
	const preparation = prepareCompactionBoundary(path, DEFAULT_COMPACTION_SETTINGS);
	assert.ok(preparation);
	assert.equal(preparation.firstKeptEntryId, path.at(-3)?.id, "the tail starts at the assistant that made the calls");
	assert.equal(preparation.keptTailMessageCount, 3);
	assert.ok(!preparation.region.lines.join("\n").includes("reading both files"), "the calls are not compacted");
	assertBothResults(requestText(compactedAt(path, preparation.firstKeptEntryId)), "the request");
});

test("an Intercom message admitted mid-batch leaves every real result in the kept tail (#5062)", () => {
	const path = session([...olderTurns(1), ...MID_BATCH]);
	const text = requestText(compactedAt(path, path.at(-5)?.id ?? null));
	assertBothResults(text, "the kept tail");
	assert.ok(text.includes("message from peer"));
});

test("an Intercom message admitted mid-batch leaves every real result in the compaction region (#5062)", () => {
	const path = session([...olderTurns(), ...MID_BATCH, ["user", "latest"], ["assistant", "ok"]]);
	const preparation = prepareCompactionBoundary(path, DEFAULT_COMPACTION_SETTINGS);
	assert.ok(preparation);
	assert.equal(preparation.firstKeptEntryId, path.at(-2)?.id);
	const region = preparation.region.lines.join("\n");
	assertBothResults(region, "the region");
	assert.ok(region.indexOf("CONTENT_OF_B") < region.indexOf("message from peer"), "the message follows the batch");
});

test("a verbatim cut at a message admitted mid-batch keeps the whole batch in the tail (#5062)", () => {
	const path = session([...olderTurns(), ...MID_BATCH]);
	const preparation = prepareCompactionBoundary(path, DEFAULT_COMPACTION_SETTINGS);
	assert.ok(preparation);
	assert.equal(preparation.firstKeptEntryId, path.at(-4)?.id, "the tail starts at the assistant that made the calls");
	assertBothResults(requestText(compactedAt(path, preparation.firstKeptEntryId)), "the request");
});

test("an Intercom message admitted mid-batch leaves every real result in a branch summary (#5062)", async () => {
	const { streamFn, state } = createFauxStreamFn(["branch summary"]);
	await generateBranchSummary(session(MID_BATCH), {
		model: fauxModel,
		apiKey: "key",
		signal: new AbortController().signal,
		streamFn,
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
	});
	assertBothResults(JSON.stringify((state.contexts as Context[])[0].messages), "the branch summary prompt");
});

test("an Intercom message admitted mid-batch leaves every real result in a session summary (#5062)", async () => {
	const { streamFn, state } = createFauxStreamFn(["session summary"]);
	await generateSessionSummary(session(MID_BATCH), {
		model: fauxModel,
		apiKey: "key",
		signal: new AbortController().signal,
		streamFn,
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
	});
	assertBothResults(JSON.stringify((state.contexts as Context[])[0].messages), "the session summary prompt");
});

test("the summary fallback never cuts at a message admitted mid-batch (#5062)", () => {
	const path = session([...olderTurns(), ...MID_BATCH]);
	const settings = { reserveTokens: 16384, keepRecentTokens: 20000 };
	const planned = preparePiSummaryCompaction(path, settings, undefined, { firstKeptEntryId: path.at(-2)?.id ?? null });
	assert.equal(planned?.firstKeptEntryId, path.at(-4)?.id, "a planned cut moves back to the calls");
	const byTokens = preparePiSummaryCompaction(path, { reserveTokens: 16384, keepRecentTokens: 1 });
	assert.equal(byTokens?.firstKeptEntryId, path.at(-4)?.id, "pi's own cut moves back to the calls");
});

test("an Intercom message admitted mid-batch leaves every real result in the summary fallback (#5062)", async () => {
	const path = session([...olderTurns(), ...MID_BATCH, ["user", "latest"], ["assistant", "ok"]]);
	const preparation = prepareCompactionBoundary(path, DEFAULT_COMPACTION_SETTINGS);
	assert.ok(preparation);
	const { streamFn, state } = createFauxStreamFn([
		{ stopReason: "error", error: "The model refused to complete the request", usage: { output: 0 } },
		"## Goal\nsummary",
		"## Goal\nsummary",
	]);
	const result = await runVerbatimCompaction(preparation, fauxModel, {
		streamFn,
		summaryEntries: path,
		resolveAuth: async () => ({ apiKey: "key" }),
		thinkingLevel: "off",
		urgency: "recoverable",
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
	});
	assert.equal(result.backend, "summary");
	assertBothResults(JSON.stringify((state.contexts as Context[])[1].messages), "the summary fallback prompt");
});

/** Where a cut at entry `cut` of `turns` lands after the batch rule, as an entry index. */
function cutOf(turns: Turn[], cut: number, floor?: number): number {
	return toolBatchCutStart(session(turns), cut, sessionEntryToContextMessages, floor);
}

test("a cut keeps its place when no later message answers a call before it (#5062)", () => {
	const answered: Turn[] = [
		["calls", "c", ["a"]],
		["result", "a", "A"],
		["user", "next"],
		["result", "x", "stray"],
	];
	assert.equal(cutOf(answered, 2), 2, "the batch was answered before the cut");
	assert.equal(cutOf(answered, 3), 3, "a result for another call does not move it");
	const unanswered: Turn[] = [
		["calls", "c", ["a"]],
		["user", "next"],
		["assistant", "ok"],
		["result", "a", "late"],
	];
	assert.equal(cutOf(unanswered, 1), 1, "a later assistant turn closes the batch");
	assert.equal(
		cutOf(
			[
				["user", "q"],
				["result", "a", "A"],
			],
			1,
		),
		1,
		"an orphan result has no call to move back to",
	);
});

test("a cut moves back only to an admitted batch inside the floor (#5062)", () => {
	const batch: Turn[] = [
		["user", "q"],
		["calls", "c", ["a", "b"]],
		["result", "a", "A"],
		["result", "b", "B"],
	];
	assert.equal(cutOf(batch, 3), 1);
	assert.equal(cutOf(batch, 3, 2), 3, "the calls sit before the floor");
	const errored = session(batch);
	(errored[1] as { message: { stopReason: string } }).message.stopReason = "error";
	assert.equal(toolBatchCutStart(errored, 3, sessionEntryToContextMessages), 3, "an errored turn admitted no call");
});
