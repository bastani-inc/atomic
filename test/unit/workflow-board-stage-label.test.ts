import assert from "node:assert/strict";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { test } from "vitest";
import { renderBoardRow } from "../../packages/coding-agent/src/modes/interactive/components/task-board.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

test("workflow board rows name the current stage once beside its progress (#5224)", () => {
	initTheme("dark", false);
	const item = {
		id: "run:nightly",
		kind: "workflow",
		state: "running",
		name: "nightly",
		task: "stage build",
		progress: { done: 1, total: 2 },
		elapsedMs: 18_000,
	} as const;
	for (const width of [80, 160]) {
		const line = stripTerminalSequences(renderBoardRow({ id: item.id, kind: "item", item }, false, width));
		assert.match(line, /build · stage 1\/2/u);
		assert.doesNotMatch(line, /stage build/u);
	}
	assert.equal(item.task, "stage build");
});
