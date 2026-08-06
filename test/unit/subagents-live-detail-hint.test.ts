import assert from "node:assert/strict";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { AgentProgress } from "../../packages/subagents/src/shared/types.js";
import { renderSubagentResult } from "../../packages/subagents/src/tui/render.js";
import { type AgentToolResult, type Details, theme } from "./subagents-render-stability-helpers.js";

// The live-detail hint renders only when the expand keybinding is registered;
// The live-detail hint renders only when the expand keybinding is registered
// and the global theme is initialized; set both up as interactive mode does.
beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

function runningProgress(index: number, agent: string): AgentProgress {
	return {
		index,
		agent,
		status: "running",
		task: `task ${index + 1}`,
		recentTools: [],
		recentOutput: [],
		toolCount: 1,
		tokens: 128,
		durationMs: 5_000,
		lastActivityAt: 10_000,
	};
}

function toolResult(details: Details): AgentToolResult<Details> {
	return { content: [{ type: "text", text: "running" }], details };
}

// Regression: a foreground parallel run mid-flight has progress entries but no
// terminal results yet. The multi renderer used to bail to a bare text line,
// so no rows, no activity, and no "Press ctrl+o for live detail" hint rendered.
test("parallel run with progress-only details renders rows and the live-detail hint", () => {
	const details: Details = {
		mode: "parallel",
		results: [],
		totalSteps: 3,
		progress: [runningProgress(0, "alpha"), runningProgress(1, "beta"), runningProgress(2, "gamma")],
	};
	for (const expanded of [false, true]) {
		const text = renderSubagentResult(toolResult(details), { expanded, now: 12_000 }, theme).render(200).join("\n");
		assert.match(text, /for live detail/, `expanded=${expanded} must offer the live-detail hint`);
		assert.match(text, /Agent 1\/3/, `expanded=${expanded} must render the first running row`);
		assert.match(text, /Agent 3\/3/, `expanded=${expanded} must render the last running row`);
		assert.match(text, /alpha/);
		assert.match(text, /gamma/);
	}
});

test("chain run with a running step and no results renders the live-detail hint", () => {
	const details: Details = {
		mode: "chain",
		results: [],
		chainAgents: ["alpha", "beta"],
		totalSteps: 2,
		currentStepIndex: 0,
		progress: [runningProgress(0, "alpha")],
	};
	for (const expanded of [false, true]) {
		const text = renderSubagentResult(toolResult(details), { expanded, now: 12_000 }, theme).render(200).join("\n");
		assert.match(text, /for live detail/, `expanded=${expanded} must offer the live-detail hint`);
		assert.match(text, /alpha/);
		assert.match(text, /pending/, `expanded=${expanded} must keep the not-started step pending`);
	}
});

test("completed multi run renders no live-detail hint", () => {
	const details: Details = {
		mode: "parallel",
		results: [],
		totalSteps: 2,
		progress: [
			{ ...runningProgress(0, "alpha"), status: "completed" },
			{ ...runningProgress(1, "beta"), status: "completed" },
		],
	};
	const text = renderSubagentResult(toolResult(details), { expanded: false, now: 12_000 }, theme)
		.render(200)
		.join("\n");
	assert.doesNotMatch(text, /for live detail/);
});
