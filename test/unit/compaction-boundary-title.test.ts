/**
 * Every compaction boundary renders one title line, with no degraded state.
 */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { beforeAll, test } from "vitest";
import type { VerbatimCompactionStats } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { createVerbatimCompactionMessage } from "../../packages/coding-agent/src/core/messages.js";
import {
	CompactionBoundaryMessageComponent,
	compactionBoundaryFromMessage,
} from "../../packages/coding-agent/src/modes/interactive/components/compaction-boundary-message.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));

const stats: VerbatimCompactionStats = {
	linesBefore: 10,
	linesDeleted: 10,
	linesKept: 0,
	rangeCount: 0,
	tokensBefore: 983_956,
	tokensAfter: 2_100,
	percentReduction: 99.8,
};

function lines(component: CompactionBoundaryMessageComponent): string[] {
	return stripVTControlCharacters(component.render(200).join("\n")).split("\n");
}

test("a cleared boundary is one line: the mark, Context cleared and the tokens before", () => {
	const rendered = lines(new CompactionBoundaryMessageComponent({ text: "Context cleared.", form: "cleared", stats }));
	assert.ok(
		rendered.some((line) => line.includes("⚛ Context cleared · 984.0k tokens")),
		rendered.join("\n"),
	);
	assert.ok(!rendered.join("\n").includes("degraded"));
});

test("a compacted boundary names the compactor model and the tokens before and after", () => {
	const rendered = lines(
		new CompactionBoundaryMessageComponent({
			text: "Context compacted.",
			form: "compacted",
			stats,
			source: "morph/morph-compactor",
		}),
	);
	assert.ok(
		rendered.some((line) => line.includes("⚛ Context compacted · morph/morph-compactor · 984.0k → 2.1k tokens")),
		rendered.join("\n"),
	);
});

test("a compactor fallback adds one line naming the reason", () => {
	const rendered = lines(
		new CompactionBoundaryMessageComponent({
			text: "Context cleared.",
			form: "cleared",
			stats,
			fallbackReason: "morph/morph-compactor failed: timed out after 120000 ms",
		}),
	).join("\n");
	assert.ok(rendered.includes("⚛ Context cleared · 984.0k tokens"));
	assert.ok(
		rendered.includes(
			"Compaction model not used (morph/morph-compactor failed: timed out after 120000 ms); context cleared instead",
		),
		rendered,
	);
});

test("expanding the boundary shows the whole recovery prompt", () => {
	const text =
		"Context cleared. Your earlier conversation (983,956 tokens) is no longer in your context window.\nThen continue the task.";
	const component = new CompactionBoundaryMessageComponent({ text, form: "cleared", stats });
	assert.ok(!lines(component).join("\n").includes("Then continue the task."));
	component.setExpanded(true);
	assert.ok(lines(component).join("\n").includes("Then continue the task."));
});

test("a boundary from an older release still renders without a degraded state", () => {
	const message = createVerbatimCompactionMessage("[User]: kept", 983_956, new Date(0).toISOString(), {
		strategy: "verbatim-lines",
		promptVersion: 6,
		parameters: { query: "q" },
		stats,
		rung: "fresh",
	});
	const rendered = lines(compactionBoundaryFromMessage(message, false)).join("\n");
	assert.ok(rendered.includes("⚛ Context cleared · 984.0k tokens"), rendered);
	assert.ok(!rendered.includes("degraded"));
});
