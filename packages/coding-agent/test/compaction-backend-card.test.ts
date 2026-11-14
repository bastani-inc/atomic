import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { convertToLlm, createVerbatimCompactionMessage } from "../src/core/messages.js";
import { buildSessionProjection, type SessionEntry } from "../src/core/session-manager.js";
import {
	CompactionBoundaryMessageComponent,
	compactionBoundaryFromMessage,
} from "../src/modes/interactive/components/compaction-boundary-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

test("labels policy-refusal summaries and the compaction model (#3470)", () => {
	initTheme("dark");
	const component = new CompactionBoundaryMessageComponent({
		text: "summary",
		rung: "planned",
		backend: "summary",
		model: "provider/model",
		stats: {
			linesBefore: 10,
			linesDeleted: 0,
			linesKept: 10,
			rangeCount: 0,
			tokensBefore: 100,
			tokensAfter: 50,
			percentReduction: 50,
		},
	});
	const text = stripVTControlCharacters(component.render(160).join("\n"));
	assert.match(text, /Context compacted · summary \(fallback\)/);
	assert.doesNotMatch(text, /pi fallback/);
	assert.match(text, /provider\/model/);
});

test("replays a pi fallback as a summary rather than claiming verbatim retention (#3470)", () => {
	const message = createVerbatimCompactionMessage("Goal: fix parser", 100, new Date(0).toISOString(), {
		backend: "summary",
	});
	const replay = convertToLlm([message]);
	assert.equal(replay.length, 1);
	assert.equal(typeof replay[0].content, "object");
	const text = JSON.stringify(replay[0].content);
	assert.match(text, /summary of the earlier conversation/);
	assert.doesNotMatch(text, /verbatim transcript/);
});

test("replays the pi summary tail as separate messages with its original roles (#3470)", () => {
	const timestamp = new Date(0).toISOString();
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "tail",
			parentId: null,
			timestamp,
			message: { role: "user", content: "keep me", timestamp: 0 },
		},
		{
			type: "compaction",
			id: "boundary",
			parentId: "tail",
			timestamp,
			summary: "checkpoint",
			firstKeptEntryId: "tail",
			tokensBefore: 100,
			details: { strategy: "verbatim-lines", backend: "summary" },
		},
	];
	const projection = buildSessionProjection(entries);
	assert.deepEqual(
		projection.messages.map((message) => message.role),
		["custom", "user"],
	);
	assert.equal(projection.entries.find((entry) => entry.sourceEntry.id === "tail")?.messages.length, 1);
});

test("live and reloaded compaction cards show only the model when collapsed or expanded (#3470)", () => {
	initTheme("dark");
	for (const backend of ["planner", "classifier", "morph", "summary"] as const) {
		const details = {
			rung: "planned" as const,
			backend,
			model: `${backend}/model`,
			stats: {
				linesBefore: 10,
				linesDeleted: 5,
				linesKept: 5,
				rangeCount: 1,
				tokensBefore: 100,
				tokensAfter: 50,
				percentReduction: 50,
			},
		};
		const live = new CompactionBoundaryMessageComponent({ text: "retained text", ...details });
		const reloaded = compactionBoundaryFromMessage(
			createVerbatimCompactionMessage("retained text", 100, new Date(0).toISOString(), details),
			false,
		);
		for (const component of [live, reloaded]) {
			for (const expanded of [false, true]) {
				component.setExpanded(expanded);
				const output = stripVTControlCharacters(component.render(160).join("\n"));
				const lines = output.split("\n").map((line) => line.trim());
				assert.ok(lines.includes(`${backend}/model`), "the model alone, without the backend");
				assert.equal(output.includes(`${backend} · `), false);
				assert.ok(output.includes("Compacted from 100 tokens"));
				assert.equal(output.includes("retained text"), expanded);
			}
		}
	}
});

test("the compaction notice names released keepContext spans briefly (#4794)", () => {
	initTheme("dark");
	const stats = {
		linesBefore: 10,
		linesDeleted: 4,
		linesKept: 6,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	};
	const released = new CompactionBoundaryMessageComponent({
		text: "kept",
		rung: "planned",
		stats,
		releasedRanges: [
			{ start: 1, end: 3, reason: "duplicate" },
			{ start: 5, end: 7, reason: "budget" },
			{ start: 8, end: 9, reason: "budget" },
		],
	});
	assert.match(
		stripVTControlCharacters(released.render(160).join("\n")),
		/Released 3 keepContext spans \(1 duplicate, 2 over budget\)/,
	);
	const message = createVerbatimCompactionMessage("kept", 100, new Date(0).toISOString(), {
		strategy: "verbatim-lines",
		stats,
		rung: "planned",
		releasedRanges: [{ start: 1, end: 3, reason: "budget" }],
	});
	const replayed = stripVTControlCharacters(compactionBoundaryFromMessage(message, false).render(160).join("\n"));
	assert.match(replayed, /Released 1 keepContext span \(1 over budget\)/);
	const plain = new CompactionBoundaryMessageComponent({ text: "kept", rung: "planned", stats });
	assert.doesNotMatch(stripVTControlCharacters(plain.render(160).join("\n")), /Released/);
});
