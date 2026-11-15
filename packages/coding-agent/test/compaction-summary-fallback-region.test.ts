import assert from "node:assert/strict";
import type { Context, Model } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { prepareCompactionBoundary } from "../src/core/compaction/compaction-boundary.js";
import {
	type CompactionUrgency,
	preparePiSummaryCompaction,
	runVerbatimCompaction,
} from "../src/core/compaction/index.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { createFauxStreamFn, type FauxResponseInput, fauxModel } from "./test-harness.js";

const timestamp = new Date(0).toISOString();
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
type Turn =
	| ["user", string]
	| ["assistant", string]
	| ["calls", string, string[]]
	| ["result", string, string]
	| ["thinking level", string];

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
			case "thinking level":
				return { ...base, type: "thinking_level_change", thinkingLevel: turn[1] };
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

const KEEP = ["<keepContext>", "NEVER-PUSH-TO-MAIN constraint", "</keepContext>"];
const filler = (lines: number, tag: string) =>
	Array.from({ length: lines }, (_, k) => `${tag} detail line ${k} ${"x".repeat(60)}`).join("\n");
const SUMMARY = "## Goal\ncheckpoint summary";
const REFUSED_BEFORE_OUTPUT: FauxResponseInput = {
	stopReason: "error",
	error: "The model refused to complete the request",
	usage: { output: 0 },
};

/** Compact `path` with the real boundary preparation; the planner refuses before output and the summary answers. */
async function compactAfterRefusal(
	path: SessionEntry[],
	options: { model?: Model<any>; urgency?: CompactionUrgency; summary?: string; preserveRecent?: number } = {},
) {
	const urgency = options.urgency ?? "recoverable";
	const parameters = options.preserveRecent === undefined ? {} : { preserve_recent: options.preserveRecent };
	const preparation = prepareCompactionBoundary(path, DEFAULT_COMPACTION_SETTINGS, parameters, {
		allowSmallRegion: urgency === "load_bearing",
	});
	assert.ok(preparation);
	const summary = options.summary ?? SUMMARY;
	const { streamFn, state } = createFauxStreamFn([REFUSED_BEFORE_OUTPUT, summary, summary]);
	const result = await runVerbatimCompaction(preparation, options.model ?? fauxModel, {
		streamFn,
		summaryEntries: path,
		resolveAuth: async () => ({ apiKey: "key" }),
		thinkingLevel: "off",
		urgency,
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
	});
	return { preparation, result, contexts: state.contexts as Context[] };
}

function promptText(context: Context): string {
	return JSON.stringify(context.messages);
}

test("a refusal summary covers a small planned region (#4975)", async () => {
	const path = session([
		["user", "Please fix the parser"],
		["assistant", filler(30, "first")],
		["user", "go on"],
		["assistant", filler(30, "second")],
		["user", "latest request"],
		["assistant", "ok"],
	]);
	const { preparation, result, contexts } = await compactAfterRefusal(path);
	assert.equal(result.backend, "summary");
	assert.equal(result.rung, "planned");
	assert.equal(contexts.length, 2);
	assert.equal(result.summaryFirstKeptEntryId, preparation.firstKeptEntryId);
	assert.match(result.text, /checkpoint summary/);
});

test("a refusal summary keeps protected spans and replaces exactly the planned region (#4975)", async () => {
	const turns: Turn[] = [["user", `${KEEP.join("\n")}\nPlease fix the parser`]];
	for (let index = 0; index < 12; index++)
		turns.push(["assistant", filler(150, `t${index}`)], ["user", `next ${index}`]);
	turns.push(["assistant", "done"], ["user", "latest request"]);
	const path = session(turns);
	const { preparation, result, contexts } = await compactAfterRefusal(path);
	assert.equal(result.backend, "summary");
	assert.equal(preparation.firstKeptEntryId, path.at(-2)?.id);
	assert.equal(result.summaryFirstKeptEntryId, preparation.firstKeptEntryId);
	assert.equal(result.keptRanges.length, 1);
	const [kept] = result.keptRanges;
	const span = preparation.region.lines.slice(kept.start - 1, kept.end);
	assert.deepEqual(span, [`[User]: ${KEEP[0]}`, ...KEEP.slice(1)]);
	assert.equal(result.text, `${span.join("\n")}\n\n${SUMMARY}`, "the span is re-inserted verbatim before the summary");
	assert.deepEqual(result.ranges, []);
	assert.deepEqual(result.releasedRanges, []);
	assert.equal(result.keptTail, true);
	assert.deepEqual(result.summary, { readFiles: [], modifiedFiles: [] });
	assert.ok(result.usage);
	assert.equal(result.summaryTokensBefore, preparation.tokensBefore);
	const textTokens = Math.ceil(result.text.length / 4);
	const { stats } = result;
	assert.deepEqual(
		{ ...stats, tokensAfter: 0, percentReduction: 0 },
		{
			linesBefore: preparation.region.lines.length,
			linesDeleted: 0,
			linesKept: result.text.split("\n").length,
			rangeCount: 0,
			tokensBefore: preparation.tokensBefore,
			tokensAfter: 0,
			percentReduction: 0,
		},
	);
	assert.ok(stats.tokensAfter > textTokens && stats.tokensAfter < textTokens + 10, "the kept tail is counted");
	assert.equal(stats.percentReduction, 100 * (1 - stats.tokensAfter / stats.tokensBefore));
	const summarised = promptText(contexts[1]);
	assert.ok(summarised.includes("t11 detail line 149"), "the whole planned region is summarised");
	assert.ok(!summarised.includes("latest request"), "the kept tail is not summarised");
});

test("a refusal summary releases the oldest protected span past its share of the window (#4975)", async () => {
	const span = (tag: string) => ["<keepContext>", filler(120, tag), "</keepContext>"].join("\n");
	const turns: Turn[] = [["user", `${span("older")}\nPlease fix the parser`]];
	for (let index = 0; index < 6; index++)
		turns.push(["assistant", filler(150, `t${index}`)], ["user", `next ${index}`]);
	turns.push(["user", `${span("newer")}\nkeep going`]);
	for (let index = 6; index < 12; index++)
		turns.push(["assistant", filler(150, `t${index}`)], ["user", `next ${index}`]);
	turns.push(["assistant", "done"], ["user", "latest request"]);
	const path = session(turns);
	const { preparation, result } = await compactAfterRefusal(path, { model: { ...fauxModel, contextWindow: 8000 } });
	assert.equal(preparation.region.releasedRanges, undefined, "both spans fit the keep target");
	assert.equal(result.backend, "summary");
	assert.ok(result.text.includes("newer detail line 119"));
	assert.ok(!result.text.includes("older detail line"));
	assert.equal(result.releasedRanges.length, 1);
	assert.equal(result.releasedRanges[0].reason, "budget");
	assert.match(preparation.region.lines[result.releasedRanges[0].start - 1], /<keepContext>/);
	assert.ok(result.releasedRanges[0].start < result.keptRanges[0].start);
});

test("a refusal summary keeps a parallel tool call with all its results in the tail (#4975)", async () => {
	const turns: Turn[] = [["user", "<keepContext>\nREGION-SPAN\n</keepContext>\nPlease fix the parser"]];
	for (let index = 0; index < 4; index++)
		turns.push(["assistant", filler(20, `t${index}`)], ["user", `next ${index}`]);
	turns.push(
		["calls", `${KEEP.join("\n")}\nreading both files`, ["call-a", "call-b"]],
		["result", "call-a", "contents of a"],
		["thinking level", "high"],
		["result", "call-b", "contents of b"],
		["assistant", "both read"],
	);
	const path = session(turns);
	const { preparation, result, contexts } = await compactAfterRefusal(path);
	const callEntry = path.at(-5)?.id;
	assert.equal(
		preparation.firstKeptEntryId,
		callEntry,
		"the planned tail starts at the assistant that made the calls",
	);
	assert.equal(result.summaryFirstKeptEntryId, callEntry, "the summary keeps the planned cut");
	const summarised = promptText(contexts[1]);
	assert.ok(summarised.includes("t3 detail line 19"));
	assert.ok(!summarised.includes("reading both files"), "the moved-back message is not summarised");
	assert.ok(!summarised.includes("contents of a"));
	assert.ok(!result.text.includes("NEVER-PUSH-TO-MAIN"), "a span kept in the tail is not repeated in the summary");
	assert.ok(result.text.startsWith("[User]: <keepContext>\nREGION-SPAN\n</keepContext>\n\n"));
	assert.equal(result.keptRanges.length, 1);
});

test("a refusal summary keeps exactly the planned tail when it starts a turn (#4975)", async () => {
	const turns: Turn[] = [["user", "Please fix the parser"]];
	for (let index = 0; index < 4; index++)
		turns.push(["assistant", filler(20, `t${index}`)], ["user", `next ${index}`]);
	turns.push(
		["calls", `${KEEP.join("\n")}\nreading`, ["call-a"]],
		["result", "call-a", "contents of a"],
		["user", "latest"],
		["assistant", "ok"],
	);
	const path = session(turns);
	const { preparation, result, contexts } = await compactAfterRefusal(path);
	assert.ok(result.text.includes("NEVER-PUSH-TO-MAIN"), "a span in the last summarised message is kept");
	assert.equal(result.summaryFirstKeptEntryId, preparation.firstKeptEntryId);
	assert.equal(result.summaryFirstKeptEntryId, path.at(-2)?.id);
	assert.ok(promptText(contexts[1]).includes("contents of a"));
});

test("a load-bearing run rejects a refusal summary over the window and starts a fresh one that fits (#4975)", async () => {
	const turns: Turn[] = [["user", "start"]];
	for (let index = 0; index < 12; index++)
		turns.push(["assistant", filler(150, `t${index}`)], ["user", `next ${index}`]);
	turns.push(["assistant", "done"], ["user", "latest"]);
	const model = { ...fauxModel, contextWindow: 16000 };
	const { result } = await compactAfterRefusal(session(turns), {
		model,
		urgency: "load_bearing",
		summary: `## Goal\n${filler(1000, "summary")}`,
	});
	assert.equal(result.rung, "fresh");
	assert.notEqual(result.backend, "summary");
	assert.ok(result.keptTail);
	assert.ok(result.stats.tokensAfter <= model.contextWindow, `${result.stats.tokensAfter} tokens fit`);
	assert.match(result.freshReason ?? "", /context window/);
});

test("a refusal summary with no planned tail summarises the whole history (#4975)", async () => {
	const path = session([
		["user", "Please fix the parser"],
		["assistant", filler(30, "first")],
		["user", "latest request"],
	]);
	const { preparation, result, contexts } = await compactAfterRefusal(path, { preserveRecent: 0 });
	assert.equal(preparation.firstKeptEntryId, null);
	assert.equal(result.backend, "summary");
	assert.equal(result.summaryFirstKeptEntryId, null);
	assert.ok(promptText(contexts[1]).includes("latest request"));
});

test("a recoverable run keeps a refusal summary that is over the window (#4975)", async () => {
	const turns: Turn[] = [["user", "start"]];
	for (let index = 0; index < 12; index++)
		turns.push(["assistant", filler(150, `t${index}`)], ["user", `next ${index}`]);
	turns.push(["assistant", "done"], ["user", "latest"]);
	const { result } = await compactAfterRefusal(session(turns), {
		model: { ...fauxModel, contextWindow: 16000 },
		summary: `## Goal\n${filler(1000, "summary")}`,
	});
	assert.equal(result.backend, "summary");
	assert.ok(result.stats.tokensAfter > 16000);
});

test("a refusal summary prepares nothing for a planned cut that is not in the history (#4975)", () => {
	const path = session([
		["user", "Please fix the parser"],
		["assistant", "working"],
	]);
	assert.equal(
		preparePiSummaryCompaction(path, { reserveTokens: 1000 }, undefined, { firstKeptEntryId: "missing" }),
		undefined,
	);
});
