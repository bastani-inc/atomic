import assert from "node:assert/strict";
import { getKeybindings, readHintSpans, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.ts";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.ts";
import { mainComposerHintSegments } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.ts";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { engineAgentPanelCounts } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	type AgentPanelCounts,
	agentPanelCounts,
	agentPanelRows,
	bindAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.ts";
import { taskRecord } from "../helpers/task-record.ts";

/**
 * A background `search` is a task of its own kind: never a panel row or an agent, and not a shell either. The hint line
 * counts it with its own noun (`1 search`), points to /tasks for it, and it does not keep stopped subagents listed.
 */

let previousKeys: ReturnType<typeof getKeybindings>;
let keybindings: KeybindingsManager;
beforeEach(() => {
	initTheme("dark", false);
	previousKeys = getKeybindings();
	keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
});
afterEach(() => {
	setKeybindings(previousKeys);
});

function search(id: string): TaskRecord {
	return { ...taskRecord(id), kind: "tool", toolName: "search", title: `search needle in history://sessions # ${id}` };
}

function shell(id: string): TaskRecord {
	return { ...taskRecord(id, "command"), title: `sleep 300 # ${id}` };
}

function stoppedAgent(id: string): TaskRecord {
	return {
		...taskRecord(id),
		agentName: "worker",
		title: "stopped work",
		execution: { kind: "settled", result: { kind: "cancelled", cause: "user" } },
	} as TaskRecord;
}

function bindTasks(session: object, tasks: readonly TaskRecord[]): void {
	bindOwnerTaskStore(session, {
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
	} as never);
}

function footerText(lines: string[]): string[] {
	return lines.map((line) => {
		const { line: text, spans } = readHintSpans(line.replace(/\x1b\[[\d;:]*m/g, ""));
		const tasks = spans.find((span) => span.start === text.indexOf("/tasks"));
		assert.ok(tasks?.action.kind === "command" && tasks.action.command === "/tasks");
		return text.trimEnd();
	});
}

describe("the main chat's hint line", () => {
	test("counts a running background search with its own noun and points to /tasks", () => {
		const session = {};
		bindTasks(session, [search("s1")]);
		assert.deepEqual(agentPanelRows(session), []);
		assert.deepEqual(agentPanelCounts(session), {
			total: 0,
			agents: 0,
			needsInput: 0,
			shells: 0,
			searches: 1,
			subagents: 0,
		});
		assert.deepEqual(mainComposerHintSegments(keybindings, session), ["1 search", "/tasks to manage", "? keys"]);
	});

	test("counts searches and shells apart, each with its own noun", () => {
		const session = {};
		bindTasks(session, [search("s1"), shell("sh1"), search("s2")]);
		assert.deepEqual(mainComposerHintSegments(keybindings, session), [
			"1 shell",
			"2 searches",
			"/tasks to manage",
			"? keys",
		]);
	});

	test("a running search does not keep a stopped subagent listed, as a running shell does", () => {
		const withSearch = {};
		bindTasks(withSearch, [stoppedAgent("a1"), search("s1")]);
		assert.deepEqual(agentPanelRows(withSearch), []);
		const withShell = {};
		bindTasks(withShell, [stoppedAgent("a1"), shell("sh1")]);
		assert.deepEqual(
			agentPanelRows(withShell).map((row) => row.id),
			["task:a1"],
		);
	});

	test("reads the same in the isolated host as in-process", () => {
		const session = {};
		bindTasks(session, [search("s1"), shell("sh1")]);
		let hostCounts: AgentPanelCounts | undefined;
		const dispose = bindAgentPanel(session as never, { setWidget() {}, requestRender() {} } as never, (counts) => {
			const message = parseInteractiveEngineMessage(
				serializeInteractiveEngineMessage({ type: "engine_agent_panel_state", ...counts }).trim(),
			);
			assert.ok(message?.type === "engine_agent_panel_state");
			hostCounts = engineAgentPanelCounts(message);
		});
		try {
			assert.ok(hostCounts);
			assert.equal(hostCounts.searches, 1);
			assert.deepEqual(
				mainComposerHintSegments(keybindings, () => hostCounts!),
				mainComposerHintSegments(keybindings, session),
			);
		} finally {
			dispose();
		}
	});
});

test("a chat's task footer counts a running search with its own noun", () => {
	assert.deepEqual(footerText(renderTaskFooter([search("s1")], 100)), ["  1 search · /tasks to manage"]);
	assert.deepEqual(footerText(renderTaskFooter([search("s1"), search("s2"), shell("sh1")], 100)), [
		"  1 shell · 2 searches · /tasks to manage",
	]);
});
