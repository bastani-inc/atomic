import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createReadToolDefinition } from "../../packages/coding-agent/src/core/tools/read.js";
import {
	type AgentPanelRow,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { ScrollableComponentViewport } from "../../packages/coding-agent/src/modes/interactive/components/chat-transcript.js";
import { openRouterGlow } from "../../packages/coding-agent/src/modes/interactive/components/provider-brand.js";
import {
	renderBoardRow,
	type TaskBoardRow,
} from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.js";
import { initTheme, refreshColorEnvironment } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { themedAgentPanelStyle } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskRecord } from "../helpers/task-record.js";
import { makeTestTui } from "../support/fake-tui.js";

/** Any SGR sequence that sets a foreground or background color: 30-49, 90-107, or 38/48 extended forms. */
const COLOR_SGR = /\x1b\[(?:[\d;]*;)?(?:3\d|4\d|9[0-7]|10[0-7])(?:;[\d;]*)?m/;

const PANEL_ROWS: AgentPanelRow[] = [
	{ id: "task:a", kind: "agent", state: "running", name: "worker", task: "fix shipping", elapsedMs: 41_000 },
	{ id: "task:b", kind: "agent", state: "input", name: "debugger", task: "which lock?", elapsedMs: 18_000 },
	{
		id: "run:r",
		kind: "agent",
		state: "running",
		name: "ralph",
		task: "stage implement",
		elapsedMs: 12_000,
		progress: { done: 3, total: 5 },
	},
	{ id: "task:c", kind: "agent", state: "failed", name: "worker", task: "picker clamp", elapsedMs: 6_000 },
	{ id: "task:d", kind: "agent", state: "done", name: "worker", task: "notes", elapsedMs: 2_000 },
];

const BOARD_ROWS: TaskBoardRow[] = (["running", "input", "queued", "done", "failed", "stopped"] as const).map(
	(state, index) => ({
		id: `i-${index}`,
		kind: "item",
		item: { id: `i-${index}`, kind: "agent", state, name: `agent-${index}`, task: `task ${state}` },
	}),
);

function toolBlockLines(isError: boolean): string[] {
	const definition = createReadToolDefinition(process.cwd());
	const block = new ToolExecutionComponent(
		"read",
		`call-${isError}`,
		{ path: "README.md" },
		{},
		definition,
		makeTestTui(24),
		process.cwd(),
	);
	block.markExecutionStarted();
	block.setArgsComplete();
	block.updateResult(
		{ content: [{ type: "text", text: isError ? "ENOENT: no such file" : "# Atomic\nline two" }], isError },
		false,
	);
	return block.render(80);
}

/** An attached transcript scrolled to its end, with its scrollbar showing. */
function scrolledTranscript(): string[] {
	const viewport = new ScrollableComponentViewport(undefined, { scrollbar: () => "always" });
	viewport.setComponents([new Text(Array.from({ length: 30 }, (_, row) => `row ${row}`).join("\n"), 0, 0)]);
	viewport.setVisibleRows(8);
	return viewport.render(40);
}

function renderViews(): Record<string, string[]> {
	const style = themedAgentPanelStyle();
	return {
		"/login provider row": [openRouterGlow("OpenRouter", 600)],
		"attached transcript scrollbar": scrolledTranscript(),
		"tool block": toolBlockLines(false),
		"failed tool block": toolBlockLines(true),
		"agent panel": [
			...renderAgentPanelRows(PANEL_ROWS, 80, style),
			...renderAgentPanelRows(PANEL_ROWS, 80, style, { selectedId: "task:b" }),
		],
		"/tasks": [
			...BOARD_ROWS.map((row, index) => renderBoardRow(row, index === 1, 80)),
			...renderTaskFooter([taskRecord("t-1"), taskRecord("t-2", "command")], 80),
		],
	};
}

beforeEach(() => {
	vi.stubEnv("FORCE_COLOR", undefined);
	vi.stubEnv("COLORTERM", "truecolor");
	vi.stubEnv("ATOMIC_REDUCED_MOTION", "1");
});

afterEach(() => {
	vi.unstubAllEnvs();
	initTheme("dark");
});

test("NO_COLOR renders the main chat's tool blocks, the agent panel, /tasks, /login's brand row and an attached transcript's scrollbar without any color, at the same widths", () => {
	vi.stubEnv("NO_COLOR", undefined);
	initTheme("dark");
	const colored = renderViews();
	assert.ok(
		Object.values(colored).some((lines) => lines.some((line) => COLOR_SGR.test(line))),
		"the same views use color when NO_COLOR is unset",
	);

	vi.stubEnv("NO_COLOR", "1");
	refreshColorEnvironment();
	const plain = renderViews();
	for (const [view, lines] of Object.entries(plain)) {
		assert.ok(lines.length > 0, view);
		for (const line of lines) assert.doesNotMatch(line, COLOR_SGR, `${view}: ${JSON.stringify(line)}`);
	}
	for (const view of Object.keys(colored)) {
		assert.deepEqual(
			plain[view]!.map((line) => visibleWidth(line)),
			colored[view]!.map((line) => visibleWidth(line)),
			`${view} keeps its layout`,
		);
		assert.deepEqual(
			plain[view]!.map((line) => stripVTControlCharacters(line)),
			colored[view]!.map((line) => stripVTControlCharacters(line)),
			`${view} keeps its text`,
		);
	}
});
