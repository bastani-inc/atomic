/**
 * The chat of a stage on a local worker runs its session commands on that stage's session in the
 * worker, as the chat of an in-process stage runs them on its own session (#3996).
 */
import type { BashResult } from "@bastani/atomic";
import { test, vi } from "vitest";
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

test("/tasks in the chat of a stage on a local worker says where its tasks run instead of showing an empty list (#3996)", async () => {
	const { view, state } = workerStageChat({});
	try {
		submitStageChatText(view, "/tasks");
		await vi.waitFor(() =>
			assert.equal(
				view._statusMessage,
				'Stage "review-a" runs on a local worker; its agents and shells are not listed in this chat.',
			),
		);
		assert.deepEqual(state.promptCalls, []);
	} finally {
		view.dispose();
	}
});
