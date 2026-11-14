import assert from "node:assert/strict";
import type { Api, Model } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { test } from "vitest";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { prepareCompactionBoundary } from "../src/core/compaction/compaction-boundary.js";
import { runVerbatimCompaction } from "../src/core/compaction/compaction-runner.js";
import type { LineRange, NumberedRegion } from "../src/core/compaction/compaction-types.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "../src/core/compaction/deleted-ranges.js";
import {
	createNumberedRegion,
	FILTERED_MARKER_RE,
	keepContextLineNumbers,
} from "../src/core/compaction/transcript-serialization.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { run } from "./compaction-planner-fixtures.js";
import { createPlannerStreamFn as createFauxStreamFn } from "./structured-planner-test-helpers.js";

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

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function entries(messages: AgentMessage[]): SessionEntry[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `m${index + 1}`,
		parentId: index === 0 ? null : `m${index}`,
		timestamp: new Date((index + 1) * 1000).toISOString(),
		message,
	}));
}

function span(...lines: string[]): string {
	return ["<keepContext>", ...lines, "</keepContext>"].join("\n");
}

/** Lines longer than any span line, so the line budget rather than the character budget binds. */
function filler(label: string, count = 6): string {
	return Array.from({ length: count }, (_, index) => `${label} detail ${index}: ordinary transcript evidence`).join(
		"\n",
	);
}

/** The region `prepareCompactionBoundary` builds for these messages, with nothing kept outside it. */
function region(messages: AgentMessage[], settings: Partial<CompactionSettings> = {}): NumberedRegion {
	const prepared = prepareCompactionBoundary(
		entries(messages),
		{ ...DEFAULT_COMPACTION_SETTINGS, ...settings },
		{ preserve_recent: 0 },
		{ allowSmallRegion: true },
	);
	assert.ok(prepared);
	return prepared.region;
}

/** Ask enforcement to delete every line, so only protection decides what survives. */
function deleteEverything(target: NumberedRegion) {
	return reconstructCompactedTranscript(
		target,
		validateDeletedRanges([{ start: 1, end: target.lines.length }], target),
	);
}

function linesOf(target: NumberedRegion, range: LineRange): string[] {
	return target.lines.slice(range.start - 1, range.end);
}

test("an older whitespace-variant duplicate span loses protection to its most recent copy (#4794)", () => {
	const messages = [
		user(`${span("Do not   edit files.", "  Report findings as JSON.")}\n${filler("brief")}`),
		assistant(filler("work a")),
		user(`${span("Do not edit files.", "Report findings as JSON.")}\n${filler("restated")}`),
		assistant(`${span("pinned decision b")}\n${filler("work b")}`),
		assistant(`${span("pinned decision c")}\n${filler("work c")}`),
		assistant(`${span("pinned decision d")}\n${filler("work d")}`),
		user("continue"),
	];
	const fits = region(messages, { keepContextShare: 1 });
	const protectedCount = fits.protectedLineNumbers?.size ?? 0;
	// A budget one line short forces a release, and dropping the duplicate alone is enough.
	const ratio = (protectedCount - 1) / fits.lines.length;
	const released = region(messages, { keepContextShare: 1, compression_ratio: ratio });
	const result = deleteEverything(released);

	assert.equal(result.releasedRanges.length, 1);
	const [duplicate] = result.releasedRanges;
	assert.equal(duplicate.reason, "duplicate");
	assert.deepEqual(linesOf(released, duplicate), [
		"[User]: <keepContext>",
		"Do not   edit files.",
		"  Report findings as JSON.",
		"</keepContext>",
	]);
	assert.ok(!result.text.includes("Do not   edit files."));
	assert.ok(result.text.includes("Do not edit files."));
	assert.equal(result.keptRanges.length, 4);
});

test("over-budget protection releases whole spans oldest first until the rest fit (#4794)", () => {
	const messages = [
		user(`${span("constraint one", "detail one")}\n${filler("one")}`),
		assistant(`${span("constraint two", "detail two")}\n${filler("two")}`),
		assistant(`${span("constraint three", "detail three")}\n${filler("three")}`),
		assistant(`${span("pinned b")}\n${filler("work b")}`),
		assistant(`${span("pinned c")}\n${filler("work c")}`),
		assistant(`${span("pinned d")}\n${filler("work d")}`),
		user("continue"),
	];
	const fits = region(messages, { keepContextShare: 1 });
	const protectedCount = fits.protectedLineNumbers?.size ?? 0;
	// Releasing the oldest 4-line span leaves one line over; releasing the second brings it under.
	const ratio = (protectedCount - 5) / fits.lines.length;
	const released = region(messages, { keepContextShare: 1, compression_ratio: ratio });
	const result = deleteEverything(released);

	assert.deepEqual(
		result.releasedRanges.map((range) => ({ reason: range.reason, first: linesOf(released, range)[1] })),
		[
			{ reason: "budget", first: "constraint one" },
			{ reason: "budget", first: "constraint two" },
		],
	);
	assert.equal(released.protectedLineNumbers?.size, protectedCount - 8);
	assert.ok(result.text.includes("constraint three"));
	assert.ok(!result.text.includes("constraint one"));
	assert.ok(!result.text.includes("constraint two"));
});

test("the most recent spans and then the latest user message are released last (#4794)", () => {
	const messages = [
		user(`${span("old constraint")}\n${filler("old")}`),
		user(`${span("latest user constraint")}\n${filler("brief")}`),
		assistant(`${span("pinned b")}\n${filler("work b")}`),
		assistant(`${span("pinned c")}\n${filler("work c")}`),
		assistant(`${span("pinned d")}\n${filler("work d")}`),
	];
	const fits = region(messages, { keepContextShare: 1 });
	const protectedCount = fits.protectedLineNumbers?.size ?? 0;
	// Each span is three lines: the budget admits all but two of them.
	const ratio = (protectedCount - 6) / fits.lines.length;
	const partial = deleteEverything(region(messages, { keepContextShare: 1, compression_ratio: ratio }));
	assert.ok(!partial.text.includes("old constraint"));
	assert.ok(!partial.text.includes("pinned b"));
	for (const kept of ["latest user constraint", "pinned c", "pinned d"]) assert.ok(partial.text.includes(kept), kept);

	const none = region(messages, { keepContextShare: 0 });
	assert.deepEqual(
		deleteEverything(none).releasedRanges.map((range) => linesOf(none, range)[1]),
		["old constraint", "latest user constraint", "pinned b", "pinned c", "pinned d"],
	);
	assert.equal(none.protectedLineNumbers, undefined);
});

test("an unclosed span is released whole, through the end of its message (#4794)", () => {
	const messages = [
		user(`<keepContext>\nunclosed constraint\n${filler("unclosed")}`),
		assistant(filler("work a")),
		assistant(`${span("pinned b")}\n${filler("work b")}`),
		assistant(`${span("pinned c")}\n${filler("work c")}`),
		assistant(`${span("pinned d")}\n${filler("work d")}`),
		user("continue"),
	];
	const fits = region(messages, { keepContextShare: 1 });
	const [unclosed] = deleteEverything(fits).keptRanges;
	const released = region(messages, { keepContextShare: 0 });
	const result = deleteEverything(released);

	assert.deepEqual(result.releasedRanges[0], { ...unclosed, reason: "budget" });
	assert.ok(!result.text.includes("unclosed constraint"));
	assert.ok(!result.text.includes("unclosed detail 5"));
});

test("protection that fits the budget is left exactly as before, duplicates included (#4794)", () => {
	const messages = [
		user(`${span("Do not edit files.")}\n${filler("brief", 30)}`),
		assistant(filler("work", 30)),
		user(`${span("Do not edit files.")}\n${filler("restated", 30)}`),
		user("continue"),
	];
	const released = region(messages);
	const result = deleteEverything(released);

	assert.equal(released.releasedRanges, undefined);
	assert.deepEqual(result.releasedRanges, []);
	assert.equal(result.keptRanges.length, 2);
	assert.equal(result.text.split("\n").filter((line) => line === "Do not edit files.").length, 2);
});

/** Deterministic PRNG so a failing case reproduces. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface GeneratedCase {
	messages: AgentMessage[];
	share: number;
	ratio: number;
}

/** A random transcript: duplicate, huge, unclosed and latest-message-only spans among ordinary lines. */
function generateCase(seed: number): GeneratedCase {
	const random = mulberry32(seed);
	const pick = (count: number) => Math.floor(random() * count);
	const messages: AgentMessage[] = [];
	const messageCount = 2 + pick(10);
	const onlyLatest = random() < 0.15;
	for (let index = 0; index < messageCount; index++) {
		const last = index === messageCount - 1;
		const parts: string[] = [];
		for (let part = pick(3); part >= 0; part--) {
			const roll = onlyLatest && !last ? 1 : random();
			if (roll < 0.3) parts.push(span(`constraint ${pick(4)}`, ...(random() < 0.5 ? [`  detail ${pick(3)}`] : [])));
			else if (roll < 0.4)
				parts.push(span(...Array.from({ length: 20 + pick(80) }, (_, line) => `huge ${seed} ${line}`)));
			else if (roll < 0.5) parts.push(`<keepContext>\nunclosed ${pick(3)}\n${filler(`open ${index}`, pick(4))}`);
			else parts.push(filler(`m${index}`, 1 + pick(6)));
		}
		const text = parts.join("\n");
		messages.push(last || random() < 0.5 ? user(text) : assistant(text));
	}
	return { messages, share: random() < 0.2 ? 1 : random(), ratio: 0.05 + random() * 0.9 };
}

function textChars(lines: readonly string[], lineNumbers: Iterable<number>): number {
	let chars = 0;
	for (const line of lineNumbers) chars += lines[line - 1].length + 1;
	return chars;
}

test("protection never exceeds its budget, and a released span is never partly protected (#4794)", () => {
	for (let seed = 1; seed <= 300; seed++) {
		const generated = generateCase(seed);
		const target = region(generated.messages, {
			keepContextShare: generated.share,
			compression_ratio: generated.ratio,
		});
		const keepTarget = Math.round(target.lines.length * generated.ratio);
		const protectedLines = target.protectedLineNumbers ?? new Set<number>();
		const totalChars = target.lines.reduce((sum, line) => sum + line.length + 1, 0);

		assert.ok(protectedLines.size <= Math.floor(keepTarget * generated.share), `seed ${seed}: protected lines`);
		assert.ok(
			textChars(target.lines, protectedLines) <= (totalChars * keepTarget * generated.share) / target.lines.length,
			`seed ${seed}: protected characters`,
		);
		// The planner can always delete down to the keep target, exactly as without tags.
		assert.ok(target.lines.length - protectedLines.size >= target.lines.length - keepTarget, `seed ${seed}`);

		const result = deleteEverything(target);
		for (const released of result.releasedRanges) {
			assert.match(target.lines[released.start - 1], /^(\[(User|Assistant)\]: )?<keepContext>$/, `seed ${seed}`);
			for (let line = released.start; line <= released.end; line++) {
				assert.ok(!protectedLines.has(line), `seed ${seed}: released line ${line} is still protected`);
			}
			assert.ok(
				!result.keptRanges.some((kept) => kept.start <= released.end && kept.end >= released.start),
				`seed ${seed}: released span overlaps a kept range`,
			);
		}
		// Whatever a plan deletes, tags add at most the protected lines to what it keeps.
		const untagged = createNumberedRegion(
			target.lines.map((line) => line.replace(/keepContext/g, "kept")).join("\n"),
		);
		const random = mulberry32(seed * 7919);
		const plan = Array.from({ length: 1 + Math.floor(random() * 6) }, () => {
			const start = 1 + Math.floor(random() * target.lines.length);
			return { start, end: Math.min(target.lines.length, start + Math.floor(random() * 30)) };
		});
		const tagged = reconstructCompactedTranscript(target, validateDeletedRanges(plan, target)).stats.linesKept;
		const plain = reconstructCompactedTranscript(untagged, validateDeletedRanges(plan, untagged)).stats.linesKept;
		assert.ok(tagged <= plain + protectedLines.size, `seed ${seed}: plan kept ${tagged} of ${plain}`);
	}
});

test("the fresh-context-window rung never fails or keeps more than the protection budget (#4794)", async () => {
	for (let seed = 1; seed <= 40; seed++) {
		const generated = generateCase(seed);
		const prepared = prepareCompactionBoundary(
			entries(generated.messages),
			{ ...DEFAULT_COMPACTION_SETTINGS, keepContextShare: generated.share },
			{ preserve_recent: 0, compression_ratio: generated.ratio },
			{ allowSmallRegion: true },
		);
		assert.ok(prepared);
		const result = await runVerbatimCompaction(
			prepared,
			model,
			run({ streamFn: createFauxStreamFn([{ error: "provider unavailable" }]).streamFn, urgency: "load_bearing" }),
		);
		assert.equal(result.rung, "fresh");
		const keptLines = result.text.split("\n").filter((line) => !FILTERED_MARKER_RE.test(line)).length;
		const keepTarget = Math.round(prepared.region.lines.length * generated.ratio);
		assert.ok(keptLines <= Math.floor(keepTarget * generated.share), `seed ${seed}: fresh kept ${keptLines}`);
		assert.deepEqual(result.releasedRanges, prepared.region.releasedRanges ?? []);
	}
});

test("a session whose keepContext spans alone exceed the context window still compacts and continues (#4794)", async () => {
	const contextWindow = 4_000;
	const big = (label: string) =>
		span(...Array.from({ length: 100 }, (_, line) => `${label} constraint line ${line} that must hold`));
	const messages = [
		...Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? user : assistant)(big(`span ${index}`))),
		user(big("latest")),
	];
	const prepared = prepareCompactionBoundary(entries(messages), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 });
	assert.ok(prepared);
	const allTagged = keepContextLineNumbers(prepared.region.lines);
	assert.ok(textChars(prepared.region.lines, allTagged) / 4 > contextWindow, "the spans alone overflow the window");

	const result = await runVerbatimCompaction(
		prepared,
		{ ...model, contextWindow },
		run({ streamFn: createFauxStreamFn([{ error: "provider unavailable" }]).streamFn, urgency: "load_bearing" }),
	);
	assert.equal(result.rung, "fresh");
	assert.equal(result.keptTail, true);
	assert.ok(result.stats.tokensAfter < contextWindow, `kept ${result.stats.tokensAfter} tokens`);
	assert.ok(result.releasedRanges.length > 0);
	assert.ok(result.text.includes("latest constraint line 0"));
});
