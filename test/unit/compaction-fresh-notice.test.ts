/**
 * RFC §5.4 — the fresh rung is loud, borrowed planning stays quiet.
 */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { beforeAll, test } from "vitest";
import type { VerbatimCompactionStats } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { CompactionBoundaryMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/compaction-boundary-message.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));

const stats: VerbatimCompactionStats = {
	linesBefore: 10,
	linesDeleted: 8,
	linesKept: 2,
	rangeCount: 1,
	tokensBefore: 100,
	tokensAfter: 20,
	percentReduction: 80,
};

function render(rung: "planned" | "extension" | "fresh"): string {
	const component = new CompactionBoundaryMessageComponent({ text: "[User]: retained", stats, rung });
	return stripVTControlCharacters(component.render(200).join("\n"));
}

test("a planned boundary keeps the ordinary success copy", () => {
	const rendered = render("planned");
	assert.ok(rendered.includes("✻ Context compacted"));
	assert.ok(!rendered.includes("compaction degraded"));
});

test("an extension boundary keeps the ordinary success copy", () => {
	assert.ok(render("extension").includes("✻ Context compacted"));
});

test("a fresh boundary says the context was cleared and compaction degraded", () => {
	const rendered = render("fresh");
	assert.ok(rendered.includes("✻ Context cleared (compaction degraded)"));
	assert.ok(!rendered.includes("✻ Context compacted"));
});
