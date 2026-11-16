import { describe, test } from "vitest";
import {
	assert,
	CTRL_X_VARIANTS,
	createStore,
	deriveGraphTheme,
	flush,
	makeHandle,
	makePendingPrompt,
	StageChatView,
	setupRun,
} from "./stage-chat-view-helpers.js";

describe("StageChatView", () => {
	test("← with a draft and Ctrl+X keep the stage chat and its draft (#5224)", () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle } = makeHandle();
		let detached = 0;
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {
				detached += 1;
			},
			onClose: () => {},
		});

		for (const ch of "draft") view.handleInput(ch);
		view.handleInput("\x18");
		view.handleInput("\x1b[D");

		assert.equal(detached, 0, "neither Ctrl+X nor ← with a draft leaves the stage chat");
		assert.equal(view._inputBuffer, "draft");
		view.dispose();
	});

	test("Escape clears bash mode instead of closing the stage chat", () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle } = makeHandle();
		let closed = 0;
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {
				closed += 1;
			},
		});

		for (const ch of "!pwd") view.handleInput(ch);
		view.handleInput("\x1b");

		assert.equal(closed, 0);
		assert.equal(view._inputBuffer, "");
		view.dispose();
	});

	test("blocked Enter is a no-op", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		store.recordStageBlocked("run-1", "stage-a", "review-a");
		const { handle, state } = makeHandle({
			promptCalls: [],
			steerCalls: [],
			followUpCalls: [],
			pauseCalls: 0,
			resumeCalls: [],
			isStreaming: true,
		});
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
		for (const ch of "ignored") view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();
		assert.deepEqual(state.promptCalls, []);
		assert.deepEqual(state.steerCalls, []);
		assert.deepEqual(state.resumeCalls, []);
		assert.equal(view._inputBuffer, "");
		assert.match(view.render(80).join("\n"), /BLOCKED/);
		view.dispose();
	});

	test("Ctrl+X variants never detach; ← on an empty prompt does (#5224)", () => {
		for (const key of CTRL_X_VARIANTS) {
			const store = createStore();
			setupRun(store, "run-1", "stage-a");
			const { handle } = makeHandle();
			let detached = 0;
			const view = new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageId: "stage-a",
				workflowName: "test-wf",
				handle,
				onDetach: () => {
					detached += 1;
				},
				onClose: () => {},
			});
			view.handleInput(key);
			assert.equal(detached, 0, JSON.stringify(key));
			view.handleInput("\x1b[D");
			assert.equal(detached, 1, JSON.stringify(key));
			view.dispose();
		}
	});

	test("← detaches from structured pending prompts without answering; Ctrl+X does not (#5224)", async () => {
		for (const key of CTRL_X_VARIANTS) {
			const store = createStore();
			setupRun(store, "run-1", "stage-a");
			const prompt = makePendingPrompt({
				id: `prompt-${JSON.stringify(key)}`,
			});
			assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
			let resolved = false;
			store.awaitStagePendingPrompt("run-1", "stage-a", prompt.id).then(() => {
				resolved = true;
			});
			const { handle } = makeHandle();
			let detached = 0;
			let closed = 0;
			const view = new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageId: "stage-a",
				workflowName: "test-wf",
				handle,
				onDetach: () => {
					detached += 1;
				},
				onClose: () => {
					closed += 1;
				},
			});

			view.handleInput(key);
			await flush();
			assert.equal(detached, 0, JSON.stringify(key));
			assert.equal(view.handleInput("\x1b[D"), true);
			await flush();
			assert.equal(detached, 1, JSON.stringify(key));
			assert.equal(closed, 0, JSON.stringify(key));
			assert.equal(resolved, false, JSON.stringify(key));
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);
			view.dispose();
		}
	});

	test("← detaches from a paused structured pending prompt without answering; Ctrl+X does not (#5224)", async () => {
		for (const key of CTRL_X_VARIANTS) {
			const store = createStore();
			setupRun(store, "run-1", "stage-a", "paused");
			const prompt = makePendingPrompt({
				id: `paused-prompt-${JSON.stringify(key)}`,
			});
			assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
			let resolved = false;
			store.awaitStagePendingPrompt("run-1", "stage-a", prompt.id).then(() => {
				resolved = true;
			});
			const { handle } = makeHandle(undefined, [], "paused");
			let detached = 0;
			let closed = 0;
			const view = new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageId: "stage-a",
				workflowName: "test-wf",
				handle,
				onDetach: () => {
					detached += 1;
				},
				onClose: () => {
					closed += 1;
				},
			});

			view.handleInput(key);
			await flush();
			assert.equal(detached, 0, JSON.stringify(key));
			assert.equal(view.handleInput("\x1b[D"), true);
			await flush();
			assert.equal(detached, 1, JSON.stringify(key));
			assert.equal(closed, 0, JSON.stringify(key));
			assert.equal(resolved, false, JSON.stringify(key));
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);
			view.dispose();
		}
	});

	test("← detaches from a paused stage chat; Ctrl+X does not (#5224)", () => {
		for (const key of CTRL_X_VARIANTS) {
			const store = createStore();
			setupRun(store, "run-1", "stage-a", "paused");
			const { handle } = makeHandle(undefined, [], "paused");
			let detached = 0;
			let closed = 0;
			const view = new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: "run-1",
				stageId: "stage-a",
				workflowName: "test-wf",
				handle,
				onDetach: () => {
					detached += 1;
				},
				onClose: () => {
					closed += 1;
				},
			});
			view.handleInput(key);
			assert.equal(detached, 0, JSON.stringify(key));
			view.handleInput("\x1b[D");
			assert.equal(detached, 1, JSON.stringify(key));
			assert.equal(closed, 0, JSON.stringify(key));
			view.dispose();
		}
	});

	test("Ctrl+D keeps ordinary editor behavior instead of leaving stage chat", () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle } = makeHandle();
		let detached = 0;
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {
				detached += 1;
			},
			onClose: () => {},
		});
		for (const ch of "draft") view.handleInput(ch);

		view.handleInput("\x04");

		assert.equal(detached, 0);
		assert.equal(view._inputBuffer, "draft");
		view.dispose();
	});
});
