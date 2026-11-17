import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { flush, makeHandle, makePendingPrompt, setupRun, stripAnsi } from "./stage-chat-view-helpers.js";

for (const kind of ["select", "confirm"] as const) {
	test(`Esc on a ${kind} question closes it back to the stage chat's prompt, never leaving, and Enter reopens it (#5224)`, async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const prompt = makePendingPrompt({
			kind,
			message: "Ship the plan?",
			...(kind === "select" ? { choices: ["alpha", "beta"] } : {}),
		});
		assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
		let settled = false;
		void store.awaitStagePendingPrompt("run-1", "stage-a", prompt.id).then(() => {
			settled = true;
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
			piKeybindings: makeFakeKeybindings(),
		});
		try {
			const text = () => stripAnsi(view.render(100).join("\n"));
			assert.match(text(), /Ship the plan\?/);
			assert.match(text(), /← graph · esc close/u);
			assert.match(text(), /esc close/i);
			assert.equal(view.handleInput("\x1b"), true);
			await flush();
			assert.equal(detached, 0, "Esc never leaves the stage chat");
			assert.equal(closed, 0);
			assert.equal(settled, false, "the question stays pending");
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);
			assert.match(text(), /❯/, "the chat's own prompt is back");
			assert.match(text(), /enter to answer/i, "the chat says how to reopen the question");
			assert.match(text(), /← (?:return to )?graph/, "the closed card leaves the chat's own ← hint");
			view.handleInput("\r");
			assert.match(text(), /Ship the plan\?/, "Enter on the empty prompt reopens the question");
			view.handleInput("\x1b");
			assert.equal(detached, 0);
			view.handleInput("\x1b[D");
			assert.equal(detached, 1, "← on the chat's empty prompt still returns to the graph");
		} finally {
			view.dispose();
		}
	});
}
