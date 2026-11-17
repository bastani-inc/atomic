import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { Details } from "../../packages/subagents/src/shared/types.js";
import { renderSingleCompact } from "../../packages/subagents/src/tui/render-result-compact.js";
import { theme } from "./subagents-render-stability-helpers.js";

type Result = Details["results"][number];

const originalKeybindings = getKeybindings();

beforeEach(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});

afterEach(() => setKeybindings(originalKeybindings));

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

function runningSteps(completed: number, currentArgs?: string): Result {
	const recentStart = Math.max(0, completed - 5);
	const recentCount = completed - recentStart;
	const base = running(completed + (currentArgs ? 1 : 0), 0);
	return {
		...base,
		progress: {
			...base.progress!,
			recentTools: Array.from({ length: recentCount }, (_, i) => ({
				tool: "bash",
				args: `step ${recentStart + i + 1}`,
				endMs: recentStart + i,
			})),
			...(currentArgs ? { currentTool: "bash", currentToolArgs: currentArgs, currentToolStartedAt: 0 } : {}),
		},
	};
}

const text = (component: { render(width: number): string[] }, width = 160) =>
	component
		.render(width)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.join("\n");

test("a running child shows its last three tool calls and one running line under its call heading (#5224)", () => {
	const out = text(renderSingleCompact(details(running(9, 5)), running(9, 5), theme, 0, 0));
	assert.doesNotMatch(out, /Agent\(|more detail the block never shows/);
	assert.match(out, /… \+6 tool uses/);
	assert.match(out, /step 3/);
	assert.match(out, /step 5/);
	assert.doesNotMatch(out, /step 2/);
	assert.match(out, /^ {2}⎿ {2}Running · 18m · ↓ 87\.4k tokens · ↓ to manage$/m);
});

test("a running child's line names no model and counts output even without tool calls (#5224)", () => {
	const child = { ...running(0, 0), model: "anthropic/claude-haiku", thinking: "low" } as Result;
	const out = text(renderSingleCompact(details(child), child, theme, 0, 0));
	assert.match(out, /⎿ {2}Running · 18m · ↓ 87\.4k tokens/);
	assert.doesNotMatch(out, /claude-haiku/);
});

test("a running card keeps each tool on one line at narrow and wide widths (#5224)", () => {
	const child = running(3, 3);
	child.progress!.recentTools = child.progress!.recentTools.map((tool) => ({ ...tool, args: "x".repeat(180) }));
	for (const width of [20, 80, 160]) {
		const lines = renderSingleCompact(details(child), child, theme, 0, 0).render(width);
		assert.equal(lines.length, 5, `three tools, activity and status at ${width} columns`);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
});

test("a running card's management hint follows rebound and disabled live keys (#5224)", () => {
	const child = running(0, 0);
	setKeybindings(new KeybindingsManager({ "app.agents.focus": "ctrl+g" }));
	assert.match(text(renderSingleCompact(details(child), child, theme, 0, 0)), /ctrl\+g to manage/);
	setKeybindings(new KeybindingsManager({ "app.agents.focus": [], "app.tools.expand": "ctrl+e" }));
	assert.match(text(renderSingleCompact(details(child), child, theme, 0, 0)), /ctrl\+e for live detail/);
	setKeybindings(new KeybindingsManager({ "app.agents.focus": [], "app.tools.expand": [] }));
	assert.doesNotMatch(text(renderSingleCompact(details(child), child, theme, 0, 0)), /to manage|for live detail/);
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
	assert.match(out, /^⏺ debugger finished · 1h 31m$/m);
	assert.doesNotMatch(out, /tool uses|tokens|⟳/);
	assert.match(out, /⎿ {2}PR #5221 open: atomic lock creation/);
	assert.doesNotMatch(out, /second line stays hidden/);
	assert.doesNotMatch(out, /session:/);
});

test("a running child keeps its completed tool beside the current tool (#5243)", () => {
	const child = runningSteps(1, "step 2");
	const out = text(renderSingleCompact(details(child), child, theme, 0, 0));
	assert.doesNotMatch(out, /… \+/);
	assert.match(out, /bash: step 1/);
	assert.match(out, /bash: step 2/);
});

test("a running child accounts for all nine tool calls while active and settled (#5243)", () => {
	const active = runningSteps(8, "step 9");
	const activeOut = text(renderSingleCompact(details(active), active, theme, 0, 0));
	assert.match(activeOut, /… \+6 tool uses/);
	assert.doesNotMatch(activeOut, /step 6/);
	assert.match(activeOut, /bash: step 7/);
	assert.match(activeOut, /bash: step 8/);
	assert.match(activeOut, /bash: step 9/);

	const betweenTools = runningSteps(9);
	const betweenOut = text(renderSingleCompact(details(betweenTools), betweenTools, theme, 0, 0));
	assert.match(betweenOut, /… \+6 tool uses/);
	assert.doesNotMatch(betweenOut, /step 6/);
	assert.match(betweenOut, /bash: step 7/);
	assert.match(betweenOut, /bash: step 9/);
	assert.match(betweenOut, /thinking…/);

	const settled = {
		...betweenTools,
		progress: undefined,
		progressSummary: { toolCount: 9, tokens: 87_400, durationMs: 18 * 60_000 },
		finalOutput: "All nine steps verified\ndetails behind expand",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "All nine steps verified\ndetails behind expand" }],
			},
		],
	} as unknown as Result;
	const settledOut = text(renderSingleCompact(details(settled), settled, theme, 0, 0));
	assert.match(settledOut, /^⏺ debugger finished · 18m$/m);
	assert.doesNotMatch(settledOut, /tool uses/);
	assert.match(settledOut, /⎿ {2}All nine steps verified/);
	assert.doesNotMatch(settledOut, /… \+|bash: step|Running|details behind expand/);
});
