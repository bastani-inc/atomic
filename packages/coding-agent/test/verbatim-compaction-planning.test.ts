import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, estimateContextTokens, estimateTokens } from "../src/core/compaction/compaction.js";
import { getKeptTailTokenEstimate, prepareCompactionBoundary } from "../src/core/compaction/compaction-boundary.js";
import { runVerbatimCompaction } from "../src/core/compaction/compaction-runner.js";
import { MAX_RANGE_PLAN_ATTEMPTS, type VerbatimCompactionPreparation } from "../src/core/compaction/compaction-types.js";
import {
	buildRangePlannerPrompt,
	extractDeletedRanges,
	planDeletedLineRanges,
	RangePlanError,
	splitRegionChunks,
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

describe("range planner", () => {
	it("extracts the first balanced JSON object from prose and fences", () => {
		expect(extractDeletedRanges("note ```json\n{\"deleted_ranges\":[{\"start\":2,\"end\":4}]}\n```"))
			.toEqual([{ start: 2, end: 4 }]);
	});

	it("bounds malformed retries and sends a corrective prompt", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn(["not json", "still wrong", '{"deleted_ranges":[{"start":2,"end":16}]}']);
		const ranges = await planDeletedLineRanges(prep.region, prep.parameters, model, { apiKey: "key" }, undefined, "off", "", { streamFn: faux.streamFn });
		expect(ranges).toEqual([{ start: 2, end: 16 }]);
		expect(faux.state.callCount).toBe(3);
		const correction = faux.state.contexts[1].messages[0];
		expect(JSON.stringify(correction)).toContain("previous reply was not valid");
	});

	it("fails after exactly MAX_RANGE_PLAN_ATTEMPTS malformed replies", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn(["not json"]);
		try {
			await planDeletedLineRanges(prep.region, prep.parameters, model, { apiKey: "key" }, undefined, "off", "", { streamFn: faux.streamFn });
			throw new Error("expected range planning to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(RangePlanError);
			expect((error as RangePlanError).attempts).toBe(MAX_RANGE_PLAN_ATTEMPTS);
		}
		expect(faux.state.callCount).toBe(MAX_RANGE_PLAN_ATTEMPTS);
	});

	it("forwards non-off thinking only for reasoning models", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn(['{"deleted_ranges":[{"start":2,"end":20}]}']);
		const options: SimpleStreamOptions[] = [];
		const capture = (candidate: Model<Api>, context: Parameters<typeof faux.streamFn>[1], request?: SimpleStreamOptions) => {
			options.push(request ?? {});
			return faux.streamFn(candidate, context, request);
		};
		await planDeletedLineRanges(prep.region, prep.parameters, { ...model, reasoning: true }, { apiKey: "key" }, undefined, "medium", "", { streamFn: capture });
		await planDeletedLineRanges(prep.region, prep.parameters, { ...model, reasoning: true }, { apiKey: "key" }, undefined, "off", "", { streamFn: capture });
		await planDeletedLineRanges(prep.region, prep.parameters, model, { apiKey: "key" }, undefined, "high", "", { streamFn: capture });
		expect(options.map((item) => item.reasoning)).toEqual(["medium", undefined, undefined]);
	});

	it("replans once when the kept-line ratio drifts high", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn([
			'{"deleted_ranges":[{"start":2,"end":10}]}',
			'{"deleted_ranges":[{"start":2,"end":20}]}',
		]);
		const ranges = await planDeletedLineRanges(prep.region, prep.parameters, model, { apiKey: "key" }, undefined, "off", "", { streamFn: faux.streamFn });
		expect(ranges).toEqual([{ start: 2, end: 20 }]);
		expect(JSON.stringify(faux.state.contexts[1])).toContain("delete at least");
	});

	it("chunks oversized regions at stable global boundaries", () => {
		const region = createNumberedRegion(Array.from({ length: 80 }, (_, index) => index % 10 === 0 ? `[User]: ${index}` : "x".repeat(100)).join("\n"));
		const smallModel = { ...model, contextWindow: 5_000 };
		const chunks = splitRegionChunks(region, smallModel);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0].start).toBe(1);
		expect(chunks.at(-1)?.end).toBe(80);
		expect(buildRangePlannerPrompt(region, preparation().parameters, chunks[1])).toContain(`lines="${chunks[1].start}-${chunks[1].end}"`);
	});

	it("clamps every chunk response and sends global numbering with per-chunk line budgets", async () => {
		const region = createNumberedRegion(Array.from({ length: 80 }, (_, index) => index % 10 === 0 ? `[User]: ${index}` : "x".repeat(100)).join("\n"));
		const smallModel = { ...model, contextWindow: 5_000 };
		const chunks = splitRegionChunks(region, smallModel);
		const faux = createFauxStreamFn(['{"deleted_ranges":[{"start":1,"end":999}]}']);
		const ranges = await planDeletedLineRanges(region, preparation().parameters, smallModel, { apiKey: "key" }, undefined, "off", "", { streamFn: faux.streamFn });
		expect(ranges).toEqual(chunks);
		for (let index = 0; index < chunks.length; index++) {
			const chunk = chunks[index];
			const prompt = JSON.stringify(faux.state.contexts[index]);
			const lineCount = chunk.end - chunk.start + 1;
			expect(prompt).toContain(`Delete approximately ${Math.round(lineCount * 0.5)} of the ${lineCount} lines`);
			expect(prompt).toContain(`lines=\\"${chunk.start}-${chunk.end}\\"`);
			expect(prompt).toContain(`${chunk.start}→`);
		}
	});
});

describe("verbatim compaction ladder", () => {
	it("accepts a non-empty standard result for manual compaction", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn(['{"deleted_ranges":[{"start":2,"end":20}]}']);
		const result = await runVerbatimCompaction(prep, model, "key", undefined, undefined, "off", { streamFn: faux.streamFn });
		expect(result.rung).toBe("standard");
		expect(result.stats.linesDeleted).toBeGreaterThan(0);
	});

	it("uses critical parameters after the standard rung misses the overflow budget", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn([
			'{"deleted_ranges":[{"start":2,"end":10}]}',
			'{"deleted_ranges":[{"start":2,"end":10}]}',
			'{"deleted_ranges":[{"start":2,"end":27}]}',
		]);
		const result = await runVerbatimCompaction(prep, model, "key", undefined, undefined, "off", {
			acceptanceTokenBudget: 1,
			criticalEvictionTokenBudget: prep.tokensBefore,
			streamFn: faux.streamFn,
		});
		expect(result.rung).toBe("critical");
		expect(JSON.stringify(faux.state.contexts)).toContain("critical-overflow-mode");
		expect(JSON.stringify(faux.state.contexts)).toContain("80% — a LINE");
	});

	it("rejects a threshold-budget miss without entering overflow rungs", async () => {
		const faux = createFauxStreamFn(['{"deleted_ranges":[{"start":2,"end":27}]}']);
		await expect(runVerbatimCompaction(preparation(), model, "key", undefined, undefined, "off", {
			acceptanceTokenBudget: 1,
			streamFn: faux.streamFn,
		})).rejects.toThrow("Compaction failed: standard achieved");
		expect(faux.state.callCount).toBe(1);
	});

	it("falls through a critical budget miss to deterministic eviction", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn(['{"deleted_ranges":[{"start":2,"end":10}]}']);
		const result = await runVerbatimCompaction(prep, model, "key", undefined, undefined, "off", {
			acceptanceTokenBudget: 1,
			criticalEvictionTokenBudget: 40,
			streamFn: faux.streamFn,
		});
		expect(result.rung).toBe("deterministic");
		expect(faux.state.callCount).toBe(6);
	});

	it("skips critical planning after provider overflow and uses deterministic eviction", async () => {
		const prep = preparation();
		const faux = createFauxStreamFn([{ error: "prompt is too long: context_length_exceeded" }]);
		const result = await runVerbatimCompaction(prep, model, "key", undefined, undefined, "off", {
			acceptanceTokenBudget: 1,
			criticalEvictionTokenBudget: prep.tokensBefore - 10,
			streamFn: faux.streamFn,
		});
		expect(result.rung).toBe("deterministic");
		expect(faux.state.callCount).toBe(1);
	});

	it("classifies a thrown provider overflow and skips critical planning", async () => {
		let calls = 0;
		const throwingStream = () => {
			calls++;
			throw new Error("prompt is too long: context_length_exceeded");
		};
		const prep = preparation();
		const result = await runVerbatimCompaction(prep, model, "key", undefined, undefined, "off", {
			acceptanceTokenBudget: 1,
			criticalEvictionTokenBudget: prep.tokensBefore - 10,
			streamFn: throwingStream,
		});
		expect(result.rung).toBe("deterministic");
		expect(calls).toBe(1);
	});

	it("honors aborts between standard and critical and between critical and deterministic", async () => {
		for (const abortAfterCall of [1, 2]) {
			const controller = new AbortController();
			const faux = createFauxStreamFn(['{"deleted_ranges":[{"start":2,"end":27}]}']);
			const abortingStream: typeof faux.streamFn = (candidate, context, request) => {
				const stream = faux.streamFn(candidate, context, request);
				if (faux.state.callCount === abortAfterCall) queueMicrotask(() => controller.abort());
				return stream;
			};
			await expect(runVerbatimCompaction(preparation(), model, "key", undefined, controller.signal, "off", {
				acceptanceTokenBudget: 1,
				criticalEvictionTokenBudget: 25,
				streamFn: abortingStream,
			})).rejects.toThrow("Compaction cancelled");
		}
	});

	it("honors abort before the first rung", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runVerbatimCompaction(preparation(), model, "key", undefined, controller.signal)).rejects.toThrow("Compaction cancelled");
	});
});
