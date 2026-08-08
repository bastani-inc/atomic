import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Container, type Terminal, Text, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import { progressEmissionFor } from "../../packages/subagents/src/runs/inprocess/runner.ts";
import type { AgentProgress, Details } from "../../packages/subagents/src/shared/types.js";
import { renderSubagentResult } from "../../packages/subagents/src/tui/render.js";
import { theme } from "./subagents-render-stability-helpers.js";

/**
 * Scrollback accounting for the Ctrl+O-expanded live subagent widget.
 *
 * A foreground subagent result renders into chat scrollback. pi-tui's
 * `TUI.doRender()` compares the whole line array and, when the earliest changed
 * row is above `previousViewportTop`, gives up on a differential update and calls
 * `fullRender(true)`, which writes `\x1b[2J\x1b[H\x1b[3J` — clear screen, home,
 * **clear scrollback**. Each of those erases the user's terminal history and
 * snaps the view to the bottom.
 *
 * These tests count that write per published progress update, not in aggregate,
 * because an aggregate count stays small while individual tool boundaries still
 * wipe the screen.
 *
 * Two things are pinned:
 *
 * 1. Non-milestone session events must produce no repaint at all. This is the
 *    regression #2205 introduced and what this change fixes.
 * 2. When the live widget fits inside the viewport alongside the rows below it,
 *    a tool boundary must cost zero scrollback clears.
 *
 * The geometric limit in (2) is deliberately measured rather than assumed: once
 * `rowsBelowWidget + widgetRows > terminalRows`, the widget's own top row sits
 * above the fold and pi-tui clears for any genuine change there. That is a pi-tui
 * behavior (upstream earendil-works/pi#4785, #7194) with no seam in this
 * repository, so `documents the geometric limit` records it as a measured fact
 * instead of letting it hide inside a loose aggregate assertion.
 */

const NOW = 1_700_000_000_000;
const COLS = 110;
const CLEAR_SCROLLBACK = "\x1b[3J";
const HISTORY_ROWS = 60;

class RecordingTerminal implements Terminal {
	writes: string[] = [];
	readonly columns = COLS;
	constructor(readonly rows: number) {}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

/** The exact live shape `inprocess-run-sync.ts` publishes while a child runs. */
function liveResult(overrides: Partial<AgentProgress>): AgentToolResult<Details> {
	const progress = {
		agent: "codebase-locator",
		index: 0,
		status: "running",
		task: "Search packages/coding-agent/src for files mentioning scrollback and summarize each.",
		durationMs: 12_000,
		toolCount: 4,
		tokens: 525,
		recentTools: [{ tool: "grep", args: '{"pattern":"scrollback"}', endMs: NOW - 3_000 }],
		recentOutput: ["found 5 files referencing scrollback"],
		lastActivityAt: NOW - 200,
		...overrides,
	} as AgentProgress;
	return {
		content: [{ type: "text", text: "running" }],
		details: {
			mode: "single",
			results: [
				{
					agent: "codebase-locator",
					task: progress.task,
					status: "continued",
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					progress,
				},
			],
		},
	};
}

class LiveSubagentWidget implements Component {
	result = liveResult({});
	render(width: number): string[] {
		return renderSubagentResult(this.result, { expanded: true, now: NOW, pulseFrame: 0 }, theme).render(width);
	}
	invalidate(): void {}
}

interface Harness {
	terminal: RecordingTerminal;
	tui: TUI;
	widget: LiveSubagentWidget;
	widgetRows: number;
	rowsBelowWidget: number;
	totalRows: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mirrors how the interactive chat mounts things: history, then the running
 * subagent tool component as the last chat child, then the editor/footer region.
 */
async function mountChat(terminalRows: number, rowsBelowWidget: number): Promise<Harness> {
	const terminal = new RecordingTerminal(terminalRows);
	const tui = new TuiMainScreen(terminal, false, "/tmp");
	const chat = new Container();
	for (let i = 0; i < HISTORY_ROWS; i += 1) chat.addChild(new Text(`history ${i}`, 0, 0));
	const widget = new LiveSubagentWidget();
	chat.addChild(widget);
	tui.addChild(chat);
	const below = new Container();
	for (let i = 0; i < rowsBelowWidget; i += 1) below.addChild(new Text(`footer ${i}`, 0, 0));
	tui.addChild(below);
	tui.requestRender();
	await sleep(40);
	const widgetRows = widget.render(COLS).length;
	return {
		terminal,
		tui,
		widget,
		widgetRows,
		rowsBelowWidget,
		totalRows: chat.render(COLS).length + rowsBelowWidget,
	};
}

/** Publish one update and report the writes it alone produced. */
async function publish(harness: Harness, next: AgentToolResult<Details>): Promise<{ clears: number; writes: number }> {
	harness.widget.result = next;
	harness.terminal.writes = [];
	harness.tui.requestRender();
	await sleep(40);
	return {
		clears: harness.terminal.writes.filter((data) => data.includes(CLEAR_SCROLLBACK)).length,
		writes: harness.terminal.writes.length,
	};
}

const toolStart = () =>
	liveResult({
		toolCount: 5,
		currentTool: "read",
		currentToolArgs: '{"path":"src/modes/interactive/interactive-render-chat.ts"}',
		currentToolStartedAt: NOW - 900,
	});
const toolEnd = () => liveResult({ toolCount: 5 });

/** One assistant turn with a tool call, as the runner observes it. */
function realisticEventStream(): AgentSessionEvent["type"][] {
	return [
		"agent_start",
		"turn_start",
		"message_start",
		...Array.from({ length: 10 }, (): AgentSessionEvent["type"] => "message_update"),
		"message_end",
		"tool_execution_start",
		...Array.from({ length: 6 }, (): AgentSessionEvent["type"] => "tool_execution_update"),
		"tool_execution_end",
		"turn_end",
		"agent_settled",
	];
}

describe("expanded live subagent widget in chat scrollback", () => {
	test("a tool boundary costs zero scrollback clears when the widget fits the viewport", async () => {
		// 26-row terminal, widget last in chat, 8 rows of editor/footer below it.
		const harness = await mountChat(26, 8);
		assert.ok(
			harness.rowsBelowWidget + harness.widgetRows <= harness.terminal.rows,
			`precondition: widget (${harness.widgetRows}) + rows below (${harness.rowsBelowWidget}) must fit in ` +
				`${harness.terminal.rows} terminal rows`,
		);

		const start = await publish(harness, toolStart());
		assert.equal(start.clears, 0, `tool_execution_start cleared scrollback ${start.clears} time(s)`);

		const end = await publish(harness, toolEnd());
		assert.equal(end.clears, 0, `tool_execution_end cleared scrollback ${end.clears} time(s)`);

		// Repeat: a per-boundary guarantee has to hold every cycle, not on average.
		for (let cycle = 0; cycle < 3; cycle += 1) {
			const s = await publish(harness, toolStart());
			assert.equal(s.clears, 0, `cycle ${cycle} tool_execution_start cleared scrollback`);
			const e = await publish(harness, toolEnd());
			assert.equal(e.clears, 0, `cycle ${cycle} tool_execution_end cleared scrollback`);
		}
	});

	test("replaying a turn publishes at milestones only, and costs far fewer clears than a catch-all", async () => {
		const stream = realisticEventStream();
		const silent = stream.filter((eventType) => progressEmissionFor(eventType) === "none");
		assert.ok(silent.length >= 16, `precondition: the stream must carry high-frequency traffic (${silent.length})`);

		// Replay the same stream twice against the same geometry: once under the
		// shipped emission table, once under the catch-all #2205 shipped
		// (`} else { emitProgress(false); }`), which published for every event.
		const replay = async (publishesEverything: boolean) => {
			// Deliberately the tight geometry, so every avoidable publish is a
			// visible scrollback wipe rather than a silent differential update.
			const harness = await mountChat(26, 20);
			const perBoundary: Record<string, number> = {};
			let publishes = 0;
			let clears = 0;
			let toolCount = 4;
			let currentTool: string | undefined;
			for (const [index, eventType] of stream.entries()) {
				const emission = progressEmissionFor(eventType);
				if (!publishesEverything && emission === "none") continue;
				if (eventType === "tool_execution_start") {
					toolCount += 1;
					currentTool = "read";
				}
				if (eventType === "tool_execution_end") currentTool = undefined;
				publishes += 1;
				// Mirror emitProgress: every publish rewrites the elapsed fields.
				// Spacing the stream across a realistic ~20 s run is what exposes
				// the catch-all's true cost -- it refreshed durationMs on every
				// event, so the widget's elapsed readout ticked (and wiped
				// scrollback) about once a second for the whole run.
				const result = await publish(
					harness,
					liveResult({
						toolCount,
						currentTool,
						currentToolArgs: currentTool ? '{"path":"a.ts"}' : undefined,
						currentToolStartedAt: currentTool ? NOW - 900 : undefined,
						durationMs: 12_000 + index * 1_000,
						lastActivityAt: NOW - 200,
					}),
				);
				clears += result.clears;
				if (eventType === "tool_execution_start" || eventType === "tool_execution_end") {
					perBoundary[eventType] = result.clears;
				}
			}
			return { publishes, clears, perBoundary };
		};

		const shipped = await replay(false);
		const catchAll = await replay(true);

		assert.equal(
			shipped.publishes,
			4,
			"agent_start, message_end, tool_execution_start, tool_execution_end — nothing else",
		);
		assert.equal(catchAll.publishes, stream.length, "the catch-all published for every session event");
		assert.ok(
			shipped.clears * 3 < catchAll.clears,
			`shipped emission cleared scrollback ${shipped.clears} times over the run against the catch-all's ` +
				`${catchAll.clears}; the whole point of the fix is that this gap is large`,
		);
		// The boundaries themselves are unchanged by the fix — they were always
		// genuine progress changes. They are pinned in the two tests above.
		assert.deepEqual(shipped.perBoundary, catchAll.perBoundary, "boundary cost is a geometry property, not a rate");
	});

	test("documents the geometric limit pi-tui imposes on above-fold repaints", async () => {
		// Same widget, same publishes, but the rows below it no longer leave room:
		// 20 + widget height exceeds the 26-row terminal, so the widget's own top
		// row is above `previousViewportTop` and pi-tui must full-redraw.
		const harness = await mountChat(26, 20);
		assert.ok(
			harness.rowsBelowWidget + harness.widgetRows > harness.terminal.rows,
			"precondition: widget must not fit alongside the rows below it",
		);

		const start = await publish(harness, toolStart());
		assert.equal(
			start.clears,
			1,
			"a genuine above-fold change still costs one pi-tui full redraw; see earendil-works/pi#4785 and #7194. " +
				"If this ever reads 0, pi-tui gained a non-destructive above-fold path and the limitation note in " +
				"evidence/README.md and both CHANGELOGs should be removed.",
		);
	});
});
