import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";
import { flush, makeHandle, makePendingPrompt, setupRun, stripAnsi } from "./stage-chat-view-helpers.ts";

for (const kind of ["select", "confirm"] as const) {
	test(`Left leaves a ${kind} question pending and reopening restores the same question (#5224)`, async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const prompt = makePendingPrompt({
			kind,
			message: "Ship the plan?",
			...(kind === "select" ? { choices: ["yes", "no"] } : {}),
		});
		assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
		let settled = false;
		void store.awaitStagePendingPrompt("run-1", "stage-a", prompt.id).then(() => {
			settled = true;
		});
		const { handle } = makeHandle();
		let detached = 0;
		const options = {
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "release",
			handle,
			onDetach: () => {
				detached += 1;
			},
			onClose: () => {},
			piKeybindings: makeFakeKeybindings(),
		};
		const view = new StageChatView(options);
		try {
			const frame = stripAnsi(view.render(100).join("\n"));
			assert.match(frame, /Ship the plan\?/u);
			assert.equal(view.handleInput("\x1b[D"), true);
			await flush();
			assert.equal(detached, 1);
			assert.match(frame, /← graph/u);
			assert.equal(settled, false);
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);
		} finally {
			view.dispose();
		}
		const restored = new StageChatView(options);
		try {
			assert.match(stripAnsi(restored.render(100).join("\n")), /Ship the plan\?/u);
			assert.equal(settled, false);
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);
			assert.equal(restored.handleInput("\r"), true);
			await flush();
			assert.equal(settled, true);
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt, undefined);
		} finally {
			restored.dispose();
		}
	});
}

test("physical Escape interrupts a stage rather than following a remapped back action (#5224)", async () => {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle, state } = makeHandle();
	state.isStreaming = true;
	let detached = 0;
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "release",
		handle,
		onDetach: () => {
			detached += 1;
		},
		onClose: () => {},
		piKeybindings: makeFakeKeybindings({ "app.nav.back": ["\x1b"] }),
	});
	try {
		view.render(100);
		assert.equal(view.handleInput("\x1b"), true);
		await flush();
		assert.equal(detached, 0);
		assert.equal(state.pauseCalls, 1);
	} finally {
		view.dispose();
	}
});
