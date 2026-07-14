import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, estimateContextTokens, estimateTokens } from "../src/core/compaction/compaction.js";
import { getKeptTailTokenEstimate, prepareCompactionBoundary } from "../src/core/compaction/compaction-boundary.js";
import { runVerbatimCompaction, targetKeepLines } from "../src/core/compaction/compaction-runner.js";
import type { VerbatimCompactionPreparation } from "../src/core/compaction/compaction-types.js";
import {
	buildRangePlannerPrompt,
	extractDeletedRanges,
	planDeletedLineRanges,
	RangePlanError,
} from "../src/core/compaction/range-planner.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";
import { buildSessionContext } from "../src/core/session-manager-history.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { createFauxStreamFn } from "./test-harness.js";

const model: Model<Api> = {
	id: "planner-test",
	name: "Planner Test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4_096,
};

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "planner-test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	};
}

function toolResult(text: string, timestamp: number): AgentMessage {
	return { role: "toolResult", toolCallId: `tool-${timestamp}`, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp };
}

function entry(id: string, message: AgentMessage, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(Number(id.slice(1)) * 1000).toISOString(), message };
}

function preparation(): VerbatimCompactionPreparation {
	const text = [
		"[User]: objective", ...Array.from({ length: 9 }, (_, index) => `objective ${index}`),
		"[Assistant]: answer", ...Array.from({ length: 9 }, (_, index) => `answer ${index}`),
		"[Tool result]: output", ...Array.from({ length: 9 }, (_, index) => `output ${index}`),
	].join("\n");
	const region = createNumberedRegion(text);
	return {
		firstKeptEntryId: "tail",
		region,
		regionEntryIds: ["a", "b"],
		keptTailMessageCount: 1,
		tokensBefore: region.tokenEstimate + 5,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "objective" },
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

describe("compaction boundary preparation", () => {
	it("widens the tail to a user turn and keeps the final turn at preserve_recent zero", () => {
		const long = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
		const entries = [
			entry("m1", user(long, 1), null),
			entry("m2", user(long, 2), "m1"),
			entry("m3", user("final", 3), "m2"),
		];
		const result = prepareCompactionBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 });
		expect(result?.firstKeptEntryId).toBe("m3");
		expect(result?.regionEntryIds).toEqual(["m1", "m2"]);
		expect(result?.keptTailMessageCount).toBe(1);
	});

	it("counts visible messages and widens assistant/tool-result recency to its user-turn start", () => {
		const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
		const entries = [
			entry("m1", user(long, 1), null),
			entry("m2", assistant("answer one", 2), "m1"),
			entry("m3", toolResult("result one", 3), "m2"),
			entry("m4", user(long, 4), "m3"),
			entry("m5", assistant("answer two", 5), "m4"),
			entry("m6", toolResult("result two", 6), "m5"),
			entry("m7", user("final", 7), "m6"),
		];
		const result = prepareCompactionBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 });
		expect(result?.firstKeptEntryId).toBe("m4");
		expect(result?.keptTailMessageCount).toBe(4);
		expect(result?.regionEntryIds).toEqual(["m1", "m2", "m3"]);
	});

	it("prepends a previous active compacted string raw", () => {
		const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
		const entries: SessionEntry[] = [
			entry("m1", user(long, 1), null),
			entry("m2", user(long, 2), "m1"),
			entry("m3", user("tail one", 3), "m2"),
			{
				type: "compaction", id: "c4", parentId: "m3", timestamp: new Date(4_000).toISOString(),
				summary: "[User]: prior\n(filtered 12 lines)", firstKeptEntryId: "m3", tokensBefore: 100,
				details: { strategy: "verbatim-lines", promptVersion: 2, parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "q" }, stats: { linesBefore: 30, linesDeleted: 12, linesKept: 18, rangeCount: 1, tokensBefore: 100, tokensAfter: 60, percentReduction: 40 }, rung: "standard" },
			},
			entry("m5", user(long, 5), "c4"),
			entry("m6", user("final", 6), "m5"),
		];
		const result = prepareCompactionBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 });
		expect(result?.region.lines.slice(0, 2)).toEqual(["[User]: prior", "(filtered 12 lines)"]);
		expect(result?.firstKeptEntryId).toBe("m6");
	});

	it("measures re-compaction against the rebuilt active context and estimates the tail independently", () => {
		const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
		const entries: SessionEntry[] = [
			entry("m1", user(long, 1), null),
			entry("m2", user(long, 2), "m1"),
			entry("m3", user("kept from prior boundary", 3), "m2"),
			{
				type: "compaction", id: "c4", parentId: "m3", timestamp: new Date(4_000).toISOString(),
				summary: "[User]: durable prior\n(filtered 40 lines)", firstKeptEntryId: "m3", tokensBefore: 500,
				details: { strategy: "verbatim-lines", promptVersion: 2, parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "q" }, stats: { linesBefore: 50, linesDeleted: 40, linesKept: 10, rangeCount: 1, tokensBefore: 500, tokensAfter: 100, percentReduction: 80 }, rung: "standard" },
			},
			entry("m5", user(long, 5), "c4"),
			entry("m6", user("final protected turn", 6), "m5"),
		];
		const result = prepareCompactionBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 });
		expect(result?.tokensBefore).toBe(estimateContextTokens(buildSessionContext(entries).messages).tokens);
		expect(result && getKeptTailTokenEstimate(result)).toBe(estimateTokens(user("final protected turn", 6)));
	});

	it("returns undefined below the region minimum", () => {
		const entries = [entry("m1", user("one", 1), null), entry("m2", user("two", 2), "m1"), entry("m3", user("three", 3), "m2")];
		expect(prepareCompactionBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })).toBeUndefined();
	});
});

describe("one-pass range planner", () => {
	it("parses only the compact d grammar", () => {
		expect(extractDeletedRanges('note {"d":[[2,4],["8",6]]} trailing')).toEqual([
			{ start: 2, end: 4 },
			{ start: "8", end: 6 },
		]);
		expect(extractDeletedRanges('{"deleted_ranges":[{"start":2,"end":4}]}')).toBeUndefined();
	});

	it("uses the evidence-tuned one-pass contract with whole-region numbering", () => {
		const prep = preparation();
		const prompt = buildRangePlannerPrompt(prep.region, prep.parameters, 12);
		expect(prompt).toContain('Target lines to keep: 12');
		expect(prompt).toContain('{"d":[[start,end],...]}');
		expect(prompt).toContain("Rank lines inside long tool results individually across the whole result");
		expect(prompt).toContain("Do not truncate by position or blanket-delete merely because a result is long");
		expect(prompt).toContain("keyword matches do not guarantee retention");
		expect(prompt).not.toContain("cannot erase generally critical context");
		expect(prompt).toContain("No category, first/last position, or top/deep stack position is automatically kept or deleted");
		expect(prompt).toContain("Treat old filtered/truncation markers as low-priority gap anchors");
		expect(prompt).toContain(`1→${prep.region.lines[0]}`);
		expect(prompt).toContain(`${prep.region.lines.length}→${prep.region.lines.at(-1)}`);
		expect(prompt).not.toContain("deleted_ranges");
	});

	it("puts the transcript first and the instructions after, matching pi's summarization prompt shape", () => {
		const prep = preparation();
		const prompt = buildRangePlannerPrompt(prep.region, prep.parameters, 12);
		expect(prompt.startsWith("<numbered-transcript>\n")).toBe(true);
		expect(prompt.indexOf("</numbered-transcript>")).toBeLessThan(prompt.indexOf("The numbered lines above are"));
		expect(prompt.indexOf("</numbered-transcript>")).toBeLessThan(prompt.indexOf('{"d":[[start,end],...]}'));
	});

	it("makes exactly one request and forwards model, auth, headers, and reasoning unchanged", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn(['{"d":[[1,20]]}']);
		const calls: Array<{ candidate: Model<Api>; request: SimpleStreamOptions }> = [];
		const capture = (candidate: Model<Api>, context: Parameters<typeof faux.streamFn>[1], request?: SimpleStreamOptions) => {
			calls.push({ candidate, request: request ?? {} });
			return faux.streamFn(candidate, context, request);
		};
		const reasoningModel = { ...model, reasoning: true };
		const ranges = await planDeletedLineRanges(
			prep.region,
			prep.parameters,
			reasoningModel,
			{ apiKey: "key", headers: { "x-test": "value" } },
			undefined,
			"medium",
			prep.settings.reserveTokens,
			10,
			{ streamFn: capture },
		);
		expect(ranges).toEqual([{ start: 1, end: 20 }]);
		expect(faux.state.callCount).toBe(1);
		expect(calls[0].candidate).toBe(reasoningModel);
		expect(calls[0].request.apiKey).toBe("key");
		expect(calls[0].request.headers).toEqual({ "x-test": "value" });
		expect(calls[0].request.reasoning).toBe("medium");
		expect(calls[0].request.maxTokens).toBe(Math.min(reasoningModel.maxTokens, Math.floor(prep.settings.reserveTokens * 0.8)));
	});

	it.each([
		["malformed", "not json"],
		["empty", '{"d":[]}'],
		["unusable", '{"d":[["nan",null]]}'],
	])("fails after one %s response with no semantic retry", async (_label, response) => {
		const prep = preparation();
		const faux = createFauxStreamFn([response]);
		await expect(planDeletedLineRanges(
			prep.region, prep.parameters, model, { apiKey: "key" }, undefined, "off", prep.settings.reserveTokens, 10, { streamFn: faux.streamFn },
		)).rejects.toBeInstanceOf(RangePlanError);
		expect(faux.state.callCount).toBe(1);
	});

	it("fails provider errors and overflow after one request", async () => {
		for (const error of ["provider unavailable", "prompt is too long: context_length_exceeded"]) {
			const prep = preparation();
			const faux = createFauxStreamFn([{ error }]);
			await expect(planDeletedLineRanges(
				prep.region, prep.parameters, model, { apiKey: "key" }, undefined, "off", prep.settings.reserveTokens, 10, { streamFn: faux.streamFn },
			)).rejects.toBeInstanceOf(RangePlanError);
			expect(faux.state.callCount).toBe(1);
		}
	});

});

describe("single planned compaction rung", () => {
	it.each(["manual", "threshold", "overflow"] as const)("makes one whole-region provider call for %s compaction", async (_reason) => {
		const prep = preparation();
		const faux = createFauxStreamFn(['{"d":[[2,10]]}']);
		await runVerbatimCompaction(prep, model, "key", undefined, undefined, "off", { streamFn: faux.streamFn });
		expect(faux.state.callCount).toBe(1);
		expect(JSON.stringify(faux.state.contexts[0])).toContain(`<numbered-transcript>`);
		expect(JSON.stringify(faux.state.contexts[0])).toContain(`${prep.region.lines.length}→`);
	});

	it("accepts a valid undershooting result without top-up or another call", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn(['{"d":[[2,2]]}']);
		const result = await runVerbatimCompaction(prep, model, "key", undefined, undefined, "off", {
			streamFn: faux.streamFn,
		});
		expect(result.rung).toBe("planned");
		expect(result.stats.linesKept).toBeGreaterThan(targetKeepLines(prep));
		expect(result.stats.linesDeleted).toBe(1);
		expect(faux.state.callCount).toBe(1);
	});
	it("uses the prepared compression ratio directly for every trigger", () => {
		const prep = preparation();
		const expected = Math.round(prep.region.lines.length * prep.parameters.compression_ratio);
		expect(targetKeepLines(prep)).toBe(expected);
	});

	it("honors abort before the request", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runVerbatimCompaction(preparation(), model, "key", undefined, controller.signal, undefined, { streamFn: createFauxStreamFn(['{"d":[[1,1]]}']).streamFn })).rejects.toThrow("Compaction cancelled");
	});
});
