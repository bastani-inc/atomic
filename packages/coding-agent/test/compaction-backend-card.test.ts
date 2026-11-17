import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { convertToLlm, createVerbatimCompactionMessage } from "../src/core/messages.js";
import { buildSessionProjection, type SessionEntry } from "../src/core/session-manager.js";
import { compactionBoundaryFromMessage } from "../src/modes/interactive/components/compaction-boundary-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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

test("boundaries from an older release render as one compacted line naming their model (#3470)", () => {
	initTheme("dark");
	for (const backend of ["planner", "classifier", "morph", "summary"] as const) {
		const details = {
			strategy: "verbatim-lines",
			promptVersion: 6,
			parameters: { query: "q" },
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
		const reloaded = compactionBoundaryFromMessage(
			createVerbatimCompactionMessage("retained text", 100, new Date(0).toISOString(), details),
			false,
		);
		for (const expanded of [false, true]) {
			reloaded.setExpanded(expanded);
			const output = stripVTControlCharacters(reloaded.render(160).join("\n"));
			assert.ok(output.includes(`⚛ Context compacted · ${backend}/model · 100 → 50 tokens`), output);
			assert.equal(output.includes("fallback"), false);
			assert.equal(output.includes("retained text"), expanded);
		}
	}
});
