import assert from "node:assert/strict";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { AgentPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { AgentPanelSourceHub } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import {
	AGENT_PANEL_MAIN_ID,
	type AgentPanelRow,
	type AgentPanelState,
	type AgentPanelStyle,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { watchAtomicWorkingClock } from "../../packages/coding-agent/src/modes/interactive/components/atomic-working-status.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindAgentPanel, themedAgentPanelStyle } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const plain: AgentPanelStyle = {
	dim: (text) => text,
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
	accent: (text) => text,
	success: (text) => text,
	error: (text) => text,
	warning: (text) => text,
};

/** Each colour role wraps its text in a named tag, so a mark's colour reads in plain text. */
const tagged: AgentPanelStyle = {
	dim: (text) => `{dim:${text}}`,
	text: (text) => `{text:${text}}`,
	muted: (text) => `{muted:${text}}`,
	border: (text) => `{border:${text}}`,
	bold: (text) => `{bold:${text}}`,
	accent: (text) => `{accent:${text}}`,
	success: (text) => `{success:${text}}`,
	error: (text) => `{error:${text}}`,
	warning: (text) => `{warning:${text}}`,
};

const worker: AgentPanelRow = {
	id: "task:a",
	kind: "agent",
	state: "running",
	name: "worker",
	task: "fix shipping batches",
	elapsedMs: 41 * 60_000,
	tokens: 96_100,
};
const debuggerRow: AgentPanelRow = {
	id: "task:b",
	kind: "agent",
	state: "running",
	name: "debugger",
	task: "#5220 spawn lock",
	elapsedMs: 18 * 60_000,
	tokens: 87_400,
};
const shell: AgentPanelRow = {
	id: "task:s",
	kind: "shell",
	state: "running",
	name: "shell",
	task: "npm test",
	elapsedMs: 12_000,
};
const finished: AgentPanelRow = {
	id: "task:c",
	kind: "agent",
	state: "done",
	name: "worker",
	task: "picker clamp",
	elapsedMs: 6 * 60_000,
};

const STATES: readonly AgentPanelState[] = [
	"running",
	"input",
	"paused",
	"queued",
	"stopping",
	"waiting",
	"done",
	"failed",
	"stopped",
];

const squeeze = (line: string) => line.replace(/(?<=\S) {2,}/g, "  ").trimEnd();

test("subagent rows show an open circle in main's mark column, and a finished one a filled circle", () => {
	const lines = renderAgentPanelRows([worker, debuggerRow, finished], 160, plain, { showMain: true });
	assert.deepEqual(lines.map(squeeze), [
		"  ● main",
		"  ◯ worker  fix shipping batches  41m · ↓ 96.1k tokens",
		"  ◯ debugger  #5220 spawn lock  18m · ↓ 87.4k tokens",
		"  ● worker  picker clamp  done · 6m",
	]);
	const tiny = renderAgentPanelRows([worker], 30, plain, { showMain: true });
	assert.deepEqual(tiny, ["  ● main", "  ◯ worker"], "below 40 columns the rows keep their mark and name");
});

test("columns 0-1 hold only the ∀ selection cursor, and the chat on screen shows by its filled mark", () => {
	const rows = [worker, debuggerRow];
	const mainShown = renderAgentPanelRows(rows, 100, plain, { selectedId: debuggerRow.id }).map(squeeze);
	assert.deepEqual(mainShown.slice(0, 3), [
		"  ● main",
		"  ◯ worker  fix shipping batches  18m · ↓ 87.4k tokens".replace("18m · ↓ 87.4k", "41m · ↓ 96.1k"),
		"∀ ◯ debugger  #5220 spawn lock  18m · ↓ 87.4k tokens",
	]);
	const workerShown = renderAgentPanelRows(rows, 100, plain, { selectedId: debuggerRow.id, viewedId: worker.id });
	assert.deepEqual(workerShown.map(squeeze).slice(0, 3), [
		"  ◯ main",
		"  ● worker  fix shipping batches  41m · ↓ 96.1k tokens",
		"∀ ◯ debugger  #5220 spawn lock  18m · ↓ 87.4k tokens",
	]);
	assert.equal(squeeze(renderAgentPanelRows(rows, 100, plain, { selectedId: AGENT_PANEL_MAIN_ID })[0]!), "∀ ● main");
	const styled = renderAgentPanelRows(rows, 100, tagged, { selectedId: worker.id });
	assert.ok(styled[1]!.startsWith("{accent:{bold:∀ }}{text:◯} "), "the cursor keeps its accent and weight");
	for (const selectedId of [undefined, AGENT_PANEL_MAIN_ID, worker.id, debuggerRow.id]) {
		for (const viewedId of [undefined, worker.id, debuggerRow.id]) {
			const lines = renderAgentPanelRows(rows, 100, plain, {
				showMain: true,
				...(selectedId === undefined ? {} : { selectedId }),
				...(viewedId === undefined ? {} : { viewedId }),
			});
			const ids = [AGENT_PANEL_MAIN_ID, worker.id, debuggerRow.id];
			for (const [index, line] of lines.slice(0, 3).entries()) {
				assert.equal(
					line.slice(0, 2),
					ids[index] === selectedId ? "∀ " : "  ",
					`${selectedId} ${viewedId}: ${line}`,
				);
			}
		}
	}
});

test("each state has one mark and colour; the chat on screen fills its open circle and reads in bold", () => {
	const expected: Record<AgentPanelState, string> = {
		running: "{muted:◯}",
		input: "{warning:◆}",
		paused: "{warning:‖}",
		queued: "{dim:○}",
		stopping: "{warning:◼}",
		waiting: "{dim:◌}",
		done: "{success:●}",
		failed: "{error:✗}",
		stopped: "{error:◯}",
	};
	const onScreen: Record<AgentPanelState, string> = {
		...expected,
		running: "{text:●}",
		stopped: "{error:●}",
	};
	for (const state of STATES) {
		const row: AgentPanelRow = { ...worker, state };
		for (const width of [30, 80, 160]) {
			const idle = renderAgentPanelRows([row], width, tagged, { showMain: true })[1]!;
			assert.ok(idle.startsWith(`  ${expected[state]} {muted:worker}`), `${state} at ${width}: ${idle}`);
			// The tags are text, so longer styled rows are clamped at 30 columns: check them where they fit.
			if (width < 80) continue;
			const viewed = renderAgentPanelRows([row], width, tagged, { showMain: true, viewedId: row.id })[1]!;
			assert.ok(
				viewed.startsWith(`  {bold:${onScreen[state]}} {bold:{text:worker}}`),
				`on screen ${state} at ${width}: ${viewed}`,
			);
			const selected = renderAgentPanelRows([row], width, tagged, { selectedId: row.id })[1]!;
			// A selected row reads in the default colour, not bold; a running row's mark with it.
			const selectedMark = state === "running" ? "{text:◯}" : expected[state];
			assert.ok(
				selected.startsWith(`{accent:{bold:∀ }}${selectedMark} {text:worker}`),
				`selected ${state}: ${selected}`,
			);
		}
	}
	const shellLine = renderAgentPanelRows([worker, shell], 160, tagged, { showMain: true, nestShells: true })[2]!;
	assert.ok(shellLine.startsWith("    {accent:⧗} "), "a running shell keeps its hourglass, nested under its subagent");
});

test("the main row is filled and bold while the screen shows main, and a muted open circle otherwise", () => {
	const main = (options: { selectedId?: string; viewedId?: string }) =>
		renderAgentPanelRows([worker], 100, tagged, { showMain: true, ...options })[0]!;
	assert.ok(main({}).startsWith("  {bold:{text:●}} {bold:{text:main  }}"), main({}));
	assert.ok(main({ viewedId: worker.id }).startsWith("  {muted:◯} {muted:main  }"), main({ viewedId: worker.id }));
	const selected = main({ selectedId: AGENT_PANEL_MAIN_ID });
	assert.ok(selected.startsWith("{accent:{bold:∀ }}{bold:{text:●}} {bold:{text:main  }}"), selected);
	// Selected while a subagent is on screen: the row reads in the default colour, as any selected row does.
	const away = main({ selectedId: AGENT_PANEL_MAIN_ID, viewedId: worker.id });
	assert.ok(away.startsWith("{accent:{bold:∀ }}{text:◯} {text:main  }"), away);
});

test("columns stay aligned across states, selection, the chat on screen and widths, and none of them moves a column", () => {
	for (const width of [30, 39, 40, 41, 69, 70, 99, 100, 101, 160]) {
		const columns = new Set<string>();
		for (const selectedId of [undefined, worker.id, debuggerRow.id, AGENT_PANEL_MAIN_ID]) {
			for (const viewedId of [undefined, worker.id, debuggerRow.id]) {
				for (const state of STATES) {
					const rows = [
						{ ...worker, state },
						{ ...debuggerRow, model: "openai/gpt-5.5", thinking: "high" },
						shell,
					];
					const lines = renderAgentPanelRows(rows, width, plain, {
						showMain: true,
						nestShells: true,
						...(selectedId === undefined ? {} : { selectedId }),
						...(viewedId === undefined ? {} : { viewedId }),
					}).map(stripVTControlCharacters);
					assert.equal(lines.length, 4);
					for (const line of lines) assert.ok(visibleWidth(line) <= width, `${state} at ${width}: ${line}`);
					// Every top-level mark in column 2 and name in column 4; the nested shell's mark under its parent's name.
					assert.equal(lines[0]!.slice(2, 8), lines[0]!.includes("●") ? "● main" : "◯ main", lines[0]);
					assert.ok("◯◆‖○◼◌●✗".includes(lines[1]![2]!), lines[1]);
					assert.equal(lines[1]!.slice(4, 10), "worker", lines[1]);
					assert.equal(lines[2]!.slice(2, 12), lines[2]![2] === "●" ? "● debugger" : "◯ debugger", lines[2]);
					assert.equal(lines[3]![4], "⧗", lines[3]);
					if (width >= 40) {
						// The task column starts in the same cell on every subagent row, whatever the first row's state.
						const taskAt = lines[2]!.indexOf("#5220");
						assert.equal(lines[3]!.indexOf("npm test"), taskAt, `nested shell task column: ${lines.join("\n")}`);
						columns.add(`${taskAt}:${lines[2]!.indexOf("openai")}:${visibleWidth(lines[2]!)}`);
					}
				}
			}
		}
		assert.ok(columns.size <= 1, `a column moved at ${width}: ${[...columns].join(" ")}`);
	}
});

test("a chat's own list without a main row draws the same marks in column 2", () => {
	const lines = renderAgentPanelRows([worker, finished], 120, plain).map(squeeze);
	assert.deepEqual(lines, [
		"  ◯ worker  fix shipping batches  41m · ↓ 96.1k tokens",
		"  ● worker  picker clamp  done · 6m",
	]);
});

test("open-circle rows keep the single-cell fast path and never measure graphemes", () => {
	const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
	try {
		for (const selectedId of [undefined, "task:probe"]) {
			segment.mockClear();
			const lines = renderAgentPanelRows(
				[
					{ ...worker, id: "task:probe", task: "open circle cost probe 7393" },
					{ ...finished, state: "stopped" },
				],
				120,
				plain,
				{ showMain: true, ...(selectedId === undefined ? {} : { selectedId }) },
			);
			assert.equal(segment.mock.calls.filter(([text]) => String(text).includes("cost probe 7393")).length, 0);
			assert.equal(visibleWidth(lines[1]!), 120);
		}
	} finally {
		segment.mockRestore();
	}
});

const runningItem: AgentPanelItem = {
	id: "run:open-circle",
	kind: "agent",
	state: "running",
	name: "ralph",
	task: "stage build",
	elapsedMs: 5_000,
};

beforeEach(() => {
	vi.useFakeTimers({ now: 100_000 });
});
afterEach(() => {
	vi.useRealTimers();
});

test("the working clock's 88 ms frames no longer repaint the panel, while its elapsed time still advances", () => {
	initTheme("dark");
	const hub = new AgentPanelSourceHub();
	hub.register({ items: () => [runningItem], subscribe: () => () => {} });
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let widget: { render(width: number): string[] } | undefined;
	let renders = 0;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: object | undefined) {
			widget = typeof content === "function" ? (content({} as never, {} as never) as never) : undefined;
		},
		requestRender() {
			renders++;
		},
	} as never);
	const stopClock = watchAtomicWorkingClock(() => {});
	const style = themedAgentPanelStyle();
	const muted = vi.spyOn(style, "muted");
	try {
		assert.ok(widget);
		const first = widget!.render(100);
		assert.match(stripVTControlCharacters(first.join("\n")), /◯ ralph/);
		for (let frame = 0; frame < 5; frame++) {
			vi.advanceTimersByTime(88);
			muted.mockClear();
			assert.equal(widget!.render(100), first, `frame ${frame} reuses the painted lines`);
			assert.equal(muted.mock.calls.length, 0, `frame ${frame} draws nothing again`);
		}
		const before = renders;
		vi.advanceTimersByTime(2_000);
		assert.ok(renders > before, "the elapsed-time tick still asks for a paint");
		const later = stripVTControlCharacters(widget!.render(100).join("\n"));
		assert.match(later, /ralph/);
		assert.notEqual(later, stripVTControlCharacters(first.join("\n")), "the elapsed time moved on");
	} finally {
		muted.mockRestore();
		stopClock();
		dispose();
	}
});
