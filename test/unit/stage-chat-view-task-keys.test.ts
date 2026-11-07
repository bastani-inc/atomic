import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.js";
import { taskRecord } from "../helpers/task-record.js";
import {
	createStore,
	deriveGraphTheme,
	makeHandle,
	makeTestTui,
	StageChatView,
	setupRun,
	submitStageChatText,
} from "./stage-chat-view-helpers.js";

test("stage owns Ctrl+O, passes Ctrl+T to host, and consumes other task-inspector keys (#4521)", async () => {
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const tasks = new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }));
	const shell = { ...taskRecord("build", "command"), title: "build task" };
	tasks.apply({
		tasks: [shell],
		background: [shell.ref.taskId],
		settlement: [],
		activity: [],
		stdin: [],
		statuses: [],
	});
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle: base, state } = makeHandle();
	let expanded = false;
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle: { ...base, placement: { kind: "local-worker", workId: "work", generation: 1 }, taskSource: () => tasks },
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(20),
		piKeybindings: keys,
		getToolsExpanded: () => expanded,
		setToolsExpanded: (value) => {
			expanded = value;
		},
	});
	try {
		submitStageChatText(view, "/tasks");
		await vi.waitFor(() => assert.match(view.render(100).join("\n"), /build task/));
		assert.equal(view.handleInput("\x0f"), true);
		assert.equal(expanded, true);
		assert.equal(view.handleInput("\x14"), false);
		assert.equal(view.handleInput("z"), true);
		assert.deepEqual(state.promptCalls, []);
	} finally {
		view.dispose();
		setKeybindings(previous);
	}
});
