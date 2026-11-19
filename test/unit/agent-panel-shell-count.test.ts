import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { matchesKey } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { AgentPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	AGENT_PANEL_MAIN_ID,
	AgentPanelFocus,
	type AgentPanelRow,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { mainComposerHintSegments } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { parseInteractiveEngineMessage } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import {
	type AgentPanelCounts,
	agentPanelCounts,
	agentPanelHasRows,
	bindAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskRecord } from "../helpers/task-record.js";

initTheme("dark");

/** An owner task store holding fixed records, enough for the panel's ranking pass. */
function bindTasks(session: object, tasks: readonly TaskRecord[]): void {
	const store = {
		tasks,
		backgroundTasks: tasks,
		ownerTasks: tasks,
		ownerBackgroundTasks: tasks,
		settlementOrder: new Map(),
		panelRevision: 1,
		taskRecord: (id: string) => tasks.find((task) => task.ref.taskId === id),
		recentActivity: () => [],
		activityOmitted: () => false,
		subscribe: () => () => {},
	};
	bindOwnerTaskStore(session, store as never);
}

function agent(id: string, title = `Task ${id}`): TaskRecord {
	return { ...taskRecord(id), agentName: "worker", title };
}

function shell(id: string): TaskRecord {
	return { ...taskRecord(id, "command"), title: `sleep 300 # ${id}` };
}

function mountPanel(session: object, onCounts?: (counts: AgentPanelCounts) => void) {
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(
		session as never,
		{
			setWidget(_key: string, content: unknown) {
				widget = typeof content === "function" ? (content({} as never, {} as never) as never) : undefined;
			},
			requestRender() {},
		} as never,
		onCounts,
	);
	const lines = (width: number) =>
		(widget?.render(width) ?? []).map((line) => stripVTControlCharacters(line).trimEnd());
	return { dispose, lines, mounted: () => widget !== undefined };
}

const extensionAgent: AgentPanelItem = {
	id: "run:wf",
	kind: "agent",
	state: "running",
	name: "ralph",
	task: "stage build",
	progress: { done: 1, total: 3 },
	elapsedMs: 5_000,
};

for (const width of [80, 160]) {
	test(`the panel lists main and the subagent but not a running shell, which the hint line counts, at ${width} columns`, () => {
		const session = {};
		bindTasks(session, [shell("sh1"), agent("a1", "fix shipping batches")]);
		const panel = mountPanel(session);
		try {
			const lines = panel.lines(width);
			assert.equal(lines.length, 2, lines.join("\n"));
			assert.equal(lines[0], "  ● main");
			assert.match(lines[1]!, /^ {2}\S worker {2}fix shipping batches/);
			assert.ok(!lines.some((line) => line.includes("sleep 300")), "a shell is not a panel row");
			assert.deepEqual(agentPanelCounts(session as never), {
				total: 1,
				agents: 1,
				needsInput: 0,
				shells: 1,
				subagents: 1,
			});
			assert.deepEqual(mainComposerHintSegments(new KeybindingsManager(), session as never), [
				"↓ 1 agent",
				"1 shell",
				"? keys",
			]);
		} finally {
			panel.dispose();
		}
	});
}

test("with only shells running there are no rows: the hint counts them and points to /tasks", () => {
	const session = {};
	bindTasks(session, [shell("sh1"), shell("sh2")]);
	const counts: AgentPanelCounts[] = [];
	const panel = mountPanel(session, (value) => counts.push(value));
	try {
		assert.equal(panel.mounted(), false, "no empty panel is mounted");
		assert.equal(agentPanelHasRows(session as never), false, "↓ has no panel to focus");
		assert.deepEqual(counts.at(-1), { total: 0, agents: 0, needsInput: 0, shells: 2, subagents: 0 });
		assert.deepEqual(mainComposerHintSegments(new KeybindingsManager(), session as never), [
			"2 shells",
			"/tasks to manage",
			"? keys",
		]);
	} finally {
		panel.dispose();
	}
});

test("finished shells are not counted", () => {
	const session = {};
	const done = shell("sh-done");
	done.execution = { kind: "settled", result: { kind: "completed", output: done.output } };
	bindTasks(session, [done]);
	assert.deepEqual(agentPanelCounts(session as never), {
		total: 0,
		agents: 0,
		needsInput: 0,
		shells: 0,
		subagents: 0,
	});
	assert.deepEqual(mainComposerHintSegments(new KeybindingsManager(), session as never), ["? keys"]);
});

test("the main row does not count toward the four-row cap", () => {
	const session = {};
	bindTasks(session, [shell("sh1"), ...Array.from({ length: 6 }, (_, index) => agent(`a${index}`))]);
	const panel = mountPanel(session);
	try {
		const lines = panel.lines(100);
		assert.equal(lines[0], "  ● main");
		assert.equal(lines.filter((line) => line.includes("worker")).length, 4);
		assert.equal(lines.at(-1), "  +2 more");
		assert.equal(lines.length, 6);
	} finally {
		panel.dispose();
	}
});

test("the focused panel keeps main above its eight rows when subagents are listed", () => {
	const focus = new AgentPanelFocus(new KeybindingsManager(), {
		open: () => {},
		stop: () => {},
		dismiss: () => {},
		close: () => {},
	});
	const rows: AgentPanelRow[] = [
		extensionAgent as AgentPanelRow,
		{ id: "task:a", kind: "agent", state: "running", name: "worker", task: "fix" },
	];
	focus.update(rows);
	assert.equal(focus.showMain, true);
	focus.selectedId = "run:wf";
	focus.handleInput("\x1b[A", (input, key) => matchesKey(input, key as "up"));
	assert.equal(focus.selectedId, AGENT_PANEL_MAIN_ID, "↑ from the first row reaches main");
});

test("the engine's panel-state message carries the shell count", () => {
	assert.deepEqual(
		parseInteractiveEngineMessage(
			JSON.stringify({ type: "engine_agent_panel_state", total: 1, needsInput: 0, shells: 2 }),
		),
		{ type: "engine_agent_panel_state", total: 1, needsInput: 0, shells: 2 },
	);
});
