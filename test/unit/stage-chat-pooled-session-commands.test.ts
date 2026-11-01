/**
 * The chat of a stage on a local worker runs its session commands on that stage's session in the
 * worker, as the chat of an in-process stage runs them on its own session (#3996).
 */
import type { BashResult } from "@bastani/atomic";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.js";
import { taskRecord } from "../helpers/task-record.js";
import {
	assert,
	createStore,
	deriveGraphTheme,
	flush,
	makeHandle,
	StageChatView,
	setupRun,
	submitStageChatText,
} from "./stage-chat-view-helpers.js";

/** The root's view of a stage on a local worker: no session in this process, only commands it sends there. */
function workerStageChat(overrides: Record<string, unknown>) {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle: base, state } = makeHandle();
	const handle = {
		...base,
		agentSession: undefined,
		placement: { kind: "local-worker" as const, workId: "work", generation: 1 },
		...overrides,
	};
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
	});
	return { view, state };
}

test("/compact in the chat of a stage on a local worker compacts that stage's session instead of sending the text to its model (#3996)", async () => {
	let compactions = 0;
	const { view, state } = workerStageChat({
		async compact() {
			compactions++;
		},
	});
	try {
		submitStageChatText(view, "/compact");
		await vi.waitFor(() => assert.equal(compactions, 1));
		await flush();
		assert.deepEqual(state.promptCalls, [], "the command is not model input");
	} finally {
		view.dispose();
	}
});

test("a ! command in the chat of a stage on a local worker runs on that stage's session and shows its output (#3996)", async () => {
	const runs: { command: string; excludeFromContext: boolean | undefined }[] = [];
	const { view, state } = workerStageChat({
		async executeBash(
			command: string,
			onChunk: (chunk: string) => void,
			options?: { readonly excludeFromContext?: boolean },
		): Promise<BashResult> {
			runs.push({ command, excludeFromContext: options?.excludeFromContext });
			onChunk("hello from the worker\n");
			return { output: "hello from the worker\n", exitCode: 0, cancelled: false, truncated: false };
		},
	});
	try {
		submitStageChatText(view, "!echo hello");
		await vi.waitFor(() => assert.match(view.render(120).join("\n"), /hello from the worker/));
		assert.deepEqual(runs, [{ command: "echo hello", excludeFromContext: false }]);
		assert.doesNotMatch(view._statusMessage, /no live agent session/);
		assert.deepEqual(state.promptCalls, []);
	} finally {
		view.dispose();
	}
});

test("/tasks in the chat of a stage on a local worker lists that stage's tasks from its worker, shows a shell's output from there, and the footer counts them (#3996)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const reads: string[] = [];
	const tasks = new PooledStageTaskSource(async (taskId, action) => {
		reads.push(`${taskId}:${action.kind}`);
		return action.kind === "output"
			? { kind: "output", result: { ok: true, value: { text: "compiling 41 of 97", omitted: false } } }
			: { kind: "detail", detail: {} };
	});
	const shell = { ...taskRecord("build", "command"), title: "npm run build" };
	tasks.apply({
		tasks: [shell],
		background: [shell.ref.taskId],
		settlement: [],
		activity: [],
		stdin: [],
		statuses: [],
	});
	const { view, state } = workerStageChat({ taskSource: () => tasks });
	try {
		assert.match(view.render(120).join("\n"), /1 shell running/, "the footer counts the worker's tasks");
		submitStageChatText(view, "/tasks");
		await vi.waitFor(() => assert.match(view.render(120).join("\n"), /npm run build/));
		view.handleInput("\r");
		await vi.waitFor(() => assert.match(view.render(120).join("\n"), /compiling 41 of 97/));
		assert.ok(reads.includes("build:output"), "the output is read on the worker");
		assert.deepEqual(state.promptCalls, []);
	} finally {
		view.dispose();
		setKeybindings(previous);
	}
});

test("a stop of a worker stage's task that does not reach the worker says so in /tasks (#3996)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const tasks = new PooledStageTaskSource(async (_taskId, action) => {
		if (action.kind === "cancel")
			throw new Error('The connection to stage "review-a" was lost; the message is sent again when it reconnects.');
		return { kind: "detail", detail: {} };
	});
	const shell = { ...taskRecord("build", "command"), title: "npm run build" };
	tasks.apply({
		tasks: [shell],
		background: [shell.ref.taskId],
		settlement: [],
		activity: [],
		stdin: [],
		statuses: [],
	});
	const { view } = workerStageChat({ taskSource: () => tasks });
	try {
		submitStageChatText(view, "/tasks");
		await vi.waitFor(() => assert.match(view.render(120).join("\n"), /npm run build/));
		view.handleInput("x");
		await vi.waitFor(() => assert.match(view.render(120).join("\n"), /y: confirm/));
		view.handleInput("y");
		await vi.waitFor(() => assert.match(view.render(120).join("\n"), /Could not stop the task: The connection/));
	} finally {
		view.dispose();
		setKeybindings(previous);
	}
});
