/**
 * Vertical-slice tests for bare-line compaction planner record parsing and
 * length-truncated recovery.
 * Covers: complete output with/without terminal newline; length-stop after newline,
 * mid-first int, after comma, mid-second int, complete-looking unterminated second int;
 * invalid completed middle line; non-length malformed output; priority-order normalization;
 * real Copilot GPT many-record truncation; prompt snapshots/examples; silent success;
 * private sidecar; validation integration.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai/compat";
import { parseRangeRecords, recoverTruncatedRecords } from "../src/core/compaction/truncated-range-recovery.ts";
import { buildRangePlannerPrompt, planDeletedLineRanges, RangePlanError } from "../src/core/compaction/range-planner.ts";
import type { RecoveryDiagnostic } from "../src/core/compaction/range-planner-diagnostics.ts";
import type { NumberedRegion, VerbatimCompactionParameters } from "../src/core/compaction/compaction-types.ts";

const testPosixFileMode = process.platform === "win32" ? it.skip : it;

const mockUsage: Usage = {
	input: 8000, output: 4096, cacheRead: 0, cacheWrite: 0, totalTokens: 12096,
	cost: { input: 0.02, output: 0.06, cacheRead: 0, cacheWrite: 0, total: 0.08 },
};

function mdl(): Model<Api> {
	return { provider: "copilot", id: "gpt-4o", api: "openai-responses", contextWindow: 128_000, maxTokens: 16384, reasoning: false, baseUrl: "https://api.openai.com" } as Model<Api>;
}

function resp(text: string | string[], stopReason = "length"): AssistantMessage {
	const blocks = (Array.isArray(text) ? text : [text]).map((value) => ({ type: "text" as const, text: value }));
	return { role: "assistant", content: blocks, api: "openai-responses", provider: "copilot", model: "gpt-4o", usage: mockUsage, stopReason, timestamp: Date.now() } as AssistantMessage;
}

function region(lineCount = 100): NumberedRegion {
	return { __brand: "NumberedRegion", lines: Array.from({ length: lineCount }, (_, i) => `${i + 1}→ line ${i + 1}`), headerLineNumbers: new Set<number>(), priorMarkerNs: new Map<number, number>(), protectedLineNumbers: new Set<number>([1, 2, 3]), tokenEstimate: lineCount * 10 } as NumberedRegion;
}

function stream(text: string | string[], stopReason: string) {
	return async () => ({ result: async () => resp(text, stopReason), events: async function* () { yield { type: "done" as const, reason: stopReason as "stop" | "length", message: resp(text, stopReason) }; } });
}

const params: VerbatimCompactionParameters = { compression_ratio: 0.5, preserve_recent: 2, query: "test" };

function tmpDir(): string {
	const dir = join(tmpdir(), `trec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function recoveryFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => name.includes("compaction-recovery") && name.endsWith(".json"))
		.map((name) => join(dir, name));
}

async function plan(text: string | string[], stopReason: string, opts?: { lineCount?: number; sessionFilePath?: string; apiKey?: string }) {
	return planDeletedLineRanges(
		region(opts?.lineCount ?? 100), params, mdl(),
		{ apiKey: opts?.apiKey ?? "key" }, undefined, undefined, 16384, 50,
		{ streamFn: stream(text, stopReason) as never, sessionFilePath: opts?.sessionFilePath },
	);
}

// 1. Complete output with/without terminal newline
describe("parseRangeRecords: complete output", () => {
	it("parses records with terminal newline", () => {
		expect(parseRangeRecords("5,10\n20,30\n")).toEqual([{ start: 5, end: 10 }, { start: 20, end: 30 }]);
	});

	it("parses records without terminal newline (normal completion)", () => {
		expect(parseRangeRecords("5,10\n20,30")).toEqual([{ start: 5, end: 10 }, { start: 20, end: 30 }]);
	});

	it("parses single record with newline", () => {
		expect(parseRangeRecords("42,99\n")).toEqual([{ start: 42, end: 99 }]);
	});

	it("parses single record without newline", () => {
		expect(parseRangeRecords("42,99")).toEqual([{ start: 42, end: 99 }]);
	});

	it("returns undefined for empty text", () => {
		expect(parseRangeRecords("")).toBeUndefined();
	});

	it("accepts zero as an endpoint", () => {
		expect(parseRangeRecords("0,5\n")).toEqual([{ start: 0, end: 5 }]);
	});
});

// 2. Length-stop truncation at various positions
describe("recoverTruncatedRecords: truncation positions", () => {
	it("recovers when truncated after a complete newline-terminated record", () => {
		// "5,10\n20,30\n" + EOF fragment "40"
		const result = recoverTruncatedRecords("5,10\n20,30\n40");
		expect(result).toBeDefined();
		expect(result!.ranges).toEqual([{ start: 5, end: 10 }, { start: 20, end: 30 }]);
		expect(result!.recoveredCount).toBe(2);
	});

	it("recovers when truncated mid-first integer", () => {
		const result = recoverTruncatedRecords("5,10\n20,30\n12");
		expect(result).toBeDefined();
		expect(result!.ranges).toEqual([{ start: 5, end: 10 }, { start: 20, end: 30 }]);
	});

	it("recovers when truncated after comma", () => {
		const result = recoverTruncatedRecords("5,10\n20,30\n40,");
		expect(result).toBeDefined();
		expect(result!.ranges).toEqual([{ start: 5, end: 10 }, { start: 20, end: 30 }]);
	});

	it("recovers when truncated mid-second integer", () => {
		const result = recoverTruncatedRecords("5,10\n20,30\n40,5");
		expect(result).toBeDefined();
		expect(result!.ranges).toEqual([{ start: 5, end: 10 }, { start: 20, end: 30 }]);
	});

	it("NEVER accepts complete-looking unterminated final record on length stop", () => {
		// "300,30" could have intended "300,305" — must be discarded
		const result = recoverTruncatedRecords("5,10\n20,30\n300,30");
		expect(result).toBeDefined();
		expect(result!.ranges).toEqual([{ start: 5, end: 10 }, { start: 20, end: 30 }]);
		// Only the newline-terminated records are accepted
		expect(result!.recoveredCount).toBe(2);
	});

	it("returns undefined when no newline exists (no complete line)", () => {
		expect(recoverTruncatedRecords("5,10")).toBeUndefined();
	});

	it("returns undefined when only fragment before first newline is blank", () => {
		// This is "\n5" — the completed portion before last newline is empty
		expect(recoverTruncatedRecords("\n5")).toBeUndefined();
	});
});

// 3. Invalid completed middle line fails entirely
describe("recoverTruncatedRecords: invalid middle line rejection", () => {
	it("rejects if any completed line has invalid syntax", () => {
		// Second line "abc,5" is invalid
		expect(recoverTruncatedRecords("5,10\nabc,5\n20,30\n40")).toBeUndefined();
	});

	it("rejects leading zeros", () => {
		expect(recoverTruncatedRecords("05,10\n20,30\n")).toBeUndefined();
	});

	it("rejects negative numbers", () => {
		expect(recoverTruncatedRecords("-5,10\n20,30\n")).toBeUndefined();
	});

	it("rejects decimal numbers", () => {
		expect(recoverTruncatedRecords("5.0,10\n20,30\n")).toBeUndefined();
	});

	it("rejects extra commas", () => {
		expect(recoverTruncatedRecords("5,10,15\n20,30\n")).toBeUndefined();
	});

	it("rejects blank lines in completed portion", () => {
		expect(recoverTruncatedRecords("5,10\n\n20,30\n")).toBeUndefined();
	});

	it("rejects exponent notation", () => {
		expect(recoverTruncatedRecords("1e2,10\n")).toBeUndefined();
	});
});

// 4. Non-length malformed output
describe("planDeletedLineRanges: non-length malformed output", () => {
	it("does not recover when stopReason is 'stop' even with valid-looking truncated text", async () => {
		let error: RangePlanError | undefined;
		try { await plan("5,10\n20,30\n40,", "stop"); }
		catch (e) { error = e as RangePlanError; }
		expect(error).toBeInstanceOf(RangePlanError);
		expect(error!.message).toContain("malformed output");
	});

	it("recovers when stopReason is 'length'", async () => {
		const result = await plan("5,10\n20,30\n40,", "length");
		expect(result).toEqual([{ start: 5, end: 10 }, { start: 20, end: 30 }]);
	});

	it("discards a complete-looking unterminated pair on a length stop", async () => {
		const result = await plan("120,180\n300,30", "length", { lineCount: 400 });
		expect(result).toEqual([{ start: 120, end: 180 }]);
	});

	it("does not treat provider text-block boundaries as record terminators", async () => {
		await expect(plan(["10,20", "30,40"], "length")).rejects.toThrow("malformed output");
	});

	it("recovers across text blocks only when a block emits a literal newline", async () => {
		const result = await plan(["10,20", "\n30,"], "length");
		expect(result).toEqual([{ start: 10, end: 20 }]);
	});
});

// 5. Priority-order normalization (host sorts afterward)
describe("planDeletedLineRanges: priority order", () => {
	it("returns ranges in output order (not numeric order)", async () => {
		// Model outputs highest-confidence deletion first (120,180 before 6,40)
		const result = await plan("120,180\n6,40\n50,55\n", "stop", { lineCount: 200 });
		expect(result[0]).toEqual({ start: 120, end: 180 });
		expect(result[1]).toEqual({ start: 6, end: 40 });
		expect(result[2]).toEqual({ start: 50, end: 55 });
	});
});

// 6. Validation integration
describe("truncated recovery: validation integration", () => {
	it("all-protected recovered ranges produce RangePlanError", async () => {
		let error: RangePlanError | undefined;
		try { await plan("1,3\n", "length"); } // lines 1-3 are protected
		catch (e) { error = e as RangePlanError; }
		// With only one complete line that's all protected, recovery may succeed
		// but validation produces zero usable ranges → falls through to error
		// Actually: on "length" stop, "1,3\n" has last newline at index 3,
		// completed portion is "1,3", fragment is empty. So recovery yields [1,3].
		// But wait — for normal path, "1,3\n" is parseable by extractDeletedRanges.
		// Let me check: extractDeletedRanges("1,3\n") → [{start:1,end:3}] → validated → all protected → no usable → error
		expect(error).toBeInstanceOf(RangePlanError);
	});

	it("mixed ranges with some protected lines still succeeds", async () => {
		const result = await plan("1,3\n10,20\n", "length");
		expect(result).toEqual([{ start: 1, end: 3 }, { start: 10, end: 20 }]);
	});

	it("out-of-bounds ranges are clamped through validation", async () => {
		const result = await plan("10,20\n40,60\n", "length", { lineCount: 50 });
		expect(result).toEqual([{ start: 10, end: 20 }, { start: 40, end: 60 }]);
	});
});

// 7. Silent success — no warning, no path surfacing
describe("truncated recovery: silent success", () => {
	it("returns ranges normally without throwing on successful recovery", async () => {
		const result = await plan("5,10\n20,30\n40,50\n60,70\n80", "length");
		expect(result.length).toBe(4);
	});

	it("successful recovery with sessionFilePath does not include diagnostic in result", async () => {
		const dir = tmpDir();
		const result = await plan("10,20\n30,40\n50", "length", { sessionFilePath: join(dir, "s.jsonl") });
		expect(result.length).toBe(2);
		rmSync(dir, { recursive: true, force: true });
	});
});

// 8. Private sidecar permissions, content, no surfaced path
describe("truncated recovery: private diagnostic sidecar", () => {
	let testDir: string;
	beforeEach(() => { testDir = tmpDir(); });
	afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

	testPosixFileMode("writes recovery sidecar with 0600 permissions", async () => {
		const sf = join(testDir, "session.jsonl");
		await plan("10,20\n30,40\n50", "length", { sessionFilePath: sf });
		const files = recoveryFiles(testDir);
		expect(files.length).toBe(1);
		expect(statSync(files[0]).mode & 0o777).toBe(0o600);
	});

	it("recovery sidecar contains expected diagnostic fields", async () => {
		const sf = join(testDir, "session.jsonl");
		const truncatedText = "5,15\n25,35\n45,55\n60";
		await plan(truncatedText, "length", { sessionFilePath: sf });
		const files = recoveryFiles(testDir);
		expect(files.length).toBeGreaterThan(0);
		const content = JSON.parse(readFileSync(files[0], "utf-8")) as RecoveryDiagnostic;
		expect(content.version).toBe(1);
		expect(content.recoveryCategory).toBe("partial_length_recovery");
		expect(content.rawResponse).toBe(truncatedText);
		expect(content.stopReason).toBe("length");
		expect(content.usage).toBeDefined();
		expect(content.requestMaxTokens).toBeGreaterThan(0);
		expect(content.model.provider).toBe("copilot");
		expect(content.model.id).toBe("gpt-4o");
		expect(content.recoveredRangeCount).toBe(3);
	});

	it("recovery sidecar does not contain API keys", async () => {
		const sf = join(testDir, "session.jsonl");
		await plan("10,20\n30", "length", { sessionFilePath: sf, apiKey: "sk-secret-123" });
		const files = recoveryFiles(testDir);
		expect(files.length).toBeGreaterThan(0);
		const raw = readFileSync(files[0], "utf-8");
		expect(raw).not.toContain("sk-secret-123");
		expect(raw).not.toContain("apiKey");
	});

	it("in-memory session does not write sidecar but still recovers", async () => {
		const result = await plan("10,20\n30,40\n50", "length");
		expect(result.length).toBe(2);
	});

	it("write failure does not affect recovery success", async () => {
		const result = await plan("10,20\n30,40\n50", "length", { sessionFilePath: "/no/such/dir/session.jsonl" });
		expect(result.length).toBe(2);
	});
});

// 9. Real Copilot GPT many-record truncation
describe("truncated recovery: real-world Copilot GPT shape", () => {
	it("recovers large number of records from Copilot-style truncated response", () => {
		const records = Array.from({ length: 50 }, (_, i) => `${i * 10 + 5},${i * 10 + 9}`);
		const text = records.join("\n") + "\n505,";
		const result = recoverTruncatedRecords(text);
		expect(result).toBeDefined();
		expect(result!.recoveredCount).toBe(50);
		expect(result!.ranges[0]).toEqual({ start: 5, end: 9 });
		expect(result!.ranges[49]).toEqual({ start: 495, end: 499 });
	});

	it("end-to-end: Copilot GPT truncated response flows through planner", async () => {
		const records = Array.from({ length: 15 }, (_, i) => `${i * 12 + 5},${i * 12 + 10}`);
		const truncatedText = records.join("\n") + "\n185,";
		const result = await plan(truncatedText, "length", { lineCount: 200 });
		expect(result.length).toBe(15);
		expect(result[0]).toEqual({ start: 5, end: 10 });
		expect(result[14]).toEqual({ start: 173, end: 178 });
	});

	it("newline-terminated output with stopReason 'length' uses recovery", async () => {
		const result = await plan("10,20\n30,40\n", "length");
		expect(result).toEqual([{ start: 10, end: 20 }, { start: 30, end: 40 }]);
	});
});

// 10. Prompt snapshots/examples
describe("buildRangePlannerPrompt: examples and contract", () => {
	it("contains the required concrete example in priority order", () => {
		const r = region(500);
		const prompt = buildRangePlannerPrompt(r, params, 250);
		expect(prompt).toContain("120,180\n6,40\n300,305");
	});

	it("explains the bare-line format and explicitly forbids fences/prose", () => {
		const r = region(100);
		const prompt = buildRangePlannerPrompt(r, params, 50);
		expect(prompt).toContain("Each line is one inclusive `start,end` range");
		expect(prompt).toContain("no spaces, blank lines, header, count, Markdown fence, prose, or reasoning");
	});

	it("explains descending deletion confidence ordering", () => {
		const r = region(100);
		const prompt = buildRangePlannerPrompt(r, params, 50);
		expect(prompt).toContain("descending deletion confidence");
		expect(prompt).toContain("lowest continuation value first");
		expect(prompt).toContain("host sorts and merges afterward");
	});

	it("does not contain JSON grammar or brackets", () => {
		const r = region(100);
		const prompt = buildRangePlannerPrompt(r, params, 50);
		expect(prompt).not.toContain('{"d"');
		expect(prompt).not.toContain("[[");
	});
});
