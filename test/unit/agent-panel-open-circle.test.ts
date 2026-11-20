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

test("subagent rows show an open circle one cell right of main's mark, and a finished one a filled circle", () => {
	const lines = renderAgentPanelRows([worker, debuggerRow, finished], 160, plain, { showMain: true });
	assert.deepEqual(lines.map(squeeze), [
		"  ● main",
		"   ◯ worker  fix shipping batches  41m · ↓ 96.1k tokens",
		"   ◯ debugger  #5220 spawn lock  18m · ↓ 87.4k tokens",
		"   ● worker  picker clamp  done · 6m",
	]);
	const tiny = renderAgentPanelRows([worker], 30, plain, { showMain: true });
	assert.deepEqual(tiny, ["  ● main", "   ◯ worker"], "below 40 columns the rows keep their mark and name");
});

test("the selection cursor is ∀ in the cursor slot, for main and for a subagent row", () => {
	const onRow = renderAgentPanelRows([worker, debuggerRow], 100, plain, { selectedId: debuggerRow.id }).map(squeeze);
	assert.equal(onRow[0], "  ● main");
	assert.match(onRow[2]!, /^∀ {2}◯ debugger {2}/);
	assert.match(onRow[1]!, /^ {3}◯ worker {2}/);
	const onMain = renderAgentPanelRows([worker], 100, plain, { selectedId: AGENT_PANEL_MAIN_ID }).map(squeeze);
	assert.equal(onMain[0], "∀ ● main");
	const styled = renderAgentPanelRows([worker], 100, tagged, { selectedId: worker.id });
	assert.ok(styled[1]!.startsWith("{accent:{bold:∀ }} "), "the cursor keeps its accent and weight");
});

test("each state has one mark and colour, whatever the selection, the view or the width", () => {
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
	for (const state of STATES) {
		const row: AgentPanelRow = { ...worker, state };
		for (const width of [30, 80, 160]) {
			const idle = renderAgentPanelRows([row], width, tagged, { showMain: true })[1]!;
			assert.ok(idle.startsWith(`   ${expected[state]} `), `${state} at ${width}: ${idle}`);
			const viewed = renderAgentPanelRows([row], width, tagged, { showMain: true, viewedId: row.id })[1]!;
			assert.ok(viewed.startsWith(`{accent:●}  ${expected[state]} `), `viewed ${state} at ${width}: ${viewed}`);
			// The tags are text, so the selected row's longer lead is clamped at 30 columns: check it where it fits.
			if (width < 80) continue;
			const selected = renderAgentPanelRows([row], width, tagged, { selectedId: row.id })[1]!;
			// A selected row reads in the default colour, a running row's mark with it.
			const selectedMark = state === "running" ? "{text:◯}" : expected[state];
			assert.ok(selected.startsWith(`{accent:{bold:∀ }} ${selectedMark} `), `selected ${state}: ${selected}`);
		}
	}
	const shellLine = renderAgentPanelRows([worker, shell], 160, tagged, { showMain: true, nestShells: true })[2]!;
	assert.ok(
		shellLine.startsWith("     {accent:⧗} "),
		"a running shell keeps its hourglass, nested under its subagent",
	);
});

test("the viewed mark stays beside the ∀ cursor's slot, and a selected viewed row keeps its highlighted name", () => {
	const rows = [worker, debuggerRow];
	const viewedOnly = renderAgentPanelRows(rows, 100, tagged, { selectedId: worker.id, viewedId: debuggerRow.id });
	assert.ok(viewedOnly[2]!.startsWith("{accent:●}  {muted:◯} {bold:{accent:debugger}}"), viewedOnly[2]);
	assert.ok(viewedOnly[1]!.startsWith("{accent:{bold:∀ }} {text:◯} {bold:{text:worker  }}"), viewedOnly[1]);
	assert.ok(viewedOnly[0]!.startsWith("  {muted:●} "), "main's mark is muted while a subagent is viewed");
	const both = renderAgentPanelRows(rows, 100, tagged, { selectedId: debuggerRow.id, viewedId: debuggerRow.id });
	assert.ok(both[2]!.startsWith("{accent:{bold:∀ }} {text:◯} {bold:{accent:debugger}}"), both[2]);
});

test("columns stay aligned across states, selection and widths, and a state change moves no column", () => {
	for (const width of [30, 39, 40, 41, 69, 70, 99, 100, 101, 160]) {
		for (const selectedId of [undefined, worker.id, debuggerRow.id, AGENT_PANEL_MAIN_ID]) {
			const columns = new Set<string>();
			for (const state of STATES) {
				const rows = [{ ...worker, state }, { ...debuggerRow, model: "openai/gpt-5.5", thinking: "high" }, shell];
				const lines = renderAgentPanelRows(rows, width, plain, {
					showMain: true,
					nestShells: true,
					...(selectedId === undefined ? {} : { selectedId }),
				}).map(stripVTControlCharacters);
				assert.equal(lines.length, 4);
				assert.equal(lines[0]!.indexOf("●"), 2, "main keeps its mark in column 2");
				for (const line of lines) assert.ok(visibleWidth(line) <= width, `${state} at ${width}: ${line}`);
				// Every subagent row's mark in column 3, its name in column 5; the nested shell's mark under them.
				assert.ok("◯◆‖○◼◌●✗".includes(lines[1]![3]!), lines[1]);
				assert.equal(lines[1]!.slice(5, 11), "worker", lines[1]);
				assert.equal(lines[2]!.slice(5, 13), "debugger", lines[2]);
				assert.equal(lines[3]![5], "⧗", lines[3]);
				if (width >= 40) {
					// The task column starts in the same cell on every subagent row, whatever the first row's state.
					const taskAt = lines[2]!.indexOf("#5220");
					const shellTaskAt = lines[3]!.indexOf("npm test");
					assert.equal(shellTaskAt, taskAt, `nested shell task column at ${width}: ${lines.join("\n")}`);
					columns.add(`${taskAt}:${lines[2]!.indexOf("openai")}:${visibleWidth(lines[2]!)}`);
				}
			}
			assert.ok(columns.size <= 1, `a state change moved a column at ${width}: ${[...columns].join(" ")}`);
		}
	}
});

test("a chat's own list without a main row keeps its marks in column 2", () => {
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
