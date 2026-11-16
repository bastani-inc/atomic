import assert from "node:assert/strict";
import { test } from "vitest";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import { renderSingleCompact } from "../../packages/subagents/src/tui/render-result-compact.js";
import { theme } from "./subagents-render-stability-helpers.js";

type Result = Details["results"][number];

function details(result: Result): Details {
	return { mode: "single", results: [result] } as Details;
}

function running(toolCount: number, recent: number): Result {
	return {
		agent: "debugger",
		task: "#5220 spawn lock\nmore detail the block never shows",
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		status: "ok",
		progress: {
			index: 0,
			agent: "debugger",
			status: "running",
			task: "#5220 spawn lock",
			recentTools: Array.from({ length: recent }, (_, i) => ({ tool: "bash", args: `step ${i + 1}`, endMs: i })),
			recentOutput: [],
			toolCount,
			tokens: 87_400,
			durationMs: 18 * 60_000,
		},
	} as unknown as Result;
}

const text = (component: { render(width: number): string[] }) => component.render(160).join("\n");

test("a running child shows Agent(name · task), its last three tool calls and one running line (#5224)", () => {
	const out = text(renderSingleCompact(details(running(9, 5)), running(9, 5), theme, 0, 0));
	assert.match(out, /Agent\(debugger · #5220 spawn lock\)/);
	assert.doesNotMatch(out, /more detail the block never shows/);
	assert.match(out, /… \+6 tool uses/);
	assert.match(out, /step 3/);
	assert.match(out, /step 5/);
	assert.doesNotMatch(out, /step 2/);
	assert.match(out, /⎿ {2}Running · 18m · ↓ 87k tokens/);
});

test("a running child with few tool calls folds nothing (#5224)", () => {
	const out = text(renderSingleCompact(details(running(2, 2)), running(2, 2), theme, 0, 0));
	assert.doesNotMatch(out, /tool uses?$/m);
	assert.doesNotMatch(out, /… \+/);
});

test("a finished child is one outcome line plus the result's headline (#5224)", () => {
	const result = {
		...running(4, 4),
		progress: undefined,
		progressSummary: { toolCount: 4, tokens: 12_000, durationMs: 91 * 60_000 },
		finalOutput: "PR #5221 open: atomic lock creation\nsecond line stays hidden",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "PR #5221 open: atomic lock creation\nsecond line stays hidden" }],
			},
		],
	} as unknown as Result;
	const out = text(renderSingleCompact(details(result), result, theme, 0, 0));
	assert.match(out, /debugger.* finished/);
	assert.match(out, /⎿ {2}PR #5221 open: atomic lock creation/);
	assert.doesNotMatch(out, /second line stays hidden/);
	assert.doesNotMatch(out, /session:/);
});
