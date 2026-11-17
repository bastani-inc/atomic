import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { injectStageLabelIntoEditorTopRule } from "../../packages/workflows/src/tui/stage-chat-view-footer-status.js";
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

test("typing into Answer <stage>… after Esc closes a question card answers the pending question instead of sending an ordinary prompt (#5224)", async () => {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const prompt = makePendingPrompt({
		kind: "select",
		message: "Ship the plan?",
		choices: ["yes", "no"],
	});
	assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
	let settled: unknown = "pending";
	void store.awaitStagePendingPrompt("run-1", "stage-a", prompt.id).then((value) => {
		settled = value;
	});
	const { handle, state } = makeHandle();
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
		piKeybindings: makeFakeKeybindings(),
	});
	try {
		assert.equal(view.handleInput("\x1b"), true);
		await flush();
		const closedFrame = stripAnsi(view.render(100).join("\n"));
		assert.match(closedFrame, /stage · review-a · needs input/u);
		assert.match(closedFrame, /Answer review-a…/u);

		for (const ch of "yes ship it") view.handleInput(ch);
		assert.equal(view.handleInput("\r"), true);
		await flush();

		assert.equal(settled, "yes ship it", "typed text settles the pending question");
		assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt, undefined);
		assert.deepEqual(state.promptCalls, [], "typed answer must not be misrouted as an ordinary stage prompt");
		assert.deepEqual(state.steerCalls, []);
		assert.equal(detached, 1);
	} finally {
		view.dispose();
	}
});

test("stage composer label states cover needs input, elapsed time, and done (#5224)", () => {
	const graphTheme = deriveGraphTheme({});
	const baseLines = ["─".repeat(80), "❯ ", "─".repeat(80)];
	const emptyHostCtx = { theme: graphTheme, chatHost: { hasInputText: () => false } } as never;
	const now = 100_000;

	const waitingLines = injectStageLabelIntoEditorTopRule(
		emptyHostCtx,
		"review-a",
		baseLines,
		{ id: "stage-a", name: "review-a", status: "awaiting_input", parentIds: [], toolEvents: [] } as never,
		now,
	).map(stripAnsi);
	assert.match(waitingLines[0]!, /stage · review-a · needs input/u);
	assert.match(waitingLines[1]!, /Answer review-a…/u);

	const runningSecondsLines = injectStageLabelIntoEditorTopRule(
		emptyHostCtx,
		"review-a",
		baseLines,
		{
			id: "stage-a",
			name: "review-a",
			status: "running",
			startedAt: now - 5_000,
			parentIds: [],
			toolEvents: [],
		} as never,
		now,
	).map(stripAnsi);
	assert.match(runningSecondsLines[0]!, /stage · review-a · 5s/u);
	assert.match(runningSecondsLines[1]!, /Message review-a…/u);

	const runningMinutesLines = injectStageLabelIntoEditorTopRule(
		emptyHostCtx,
		"review-a",
		baseLines,
		{
			id: "stage-a",
			name: "review-a",
			status: "running",
			startedAt: now - 65_000,
			parentIds: [],
			toolEvents: [],
		} as never,
		now,
	).map(stripAnsi);
	assert.match(runningMinutesLines[0]!, /stage · review-a · 1m/u);

	const runningHoursLines = injectStageLabelIntoEditorTopRule(
		emptyHostCtx,
		"review-a",
		baseLines,
		{
			id: "stage-a",
			name: "review-a",
			status: "running",
			startedAt: now - 3_960_000,
			parentIds: [],
			toolEvents: [],
		} as never,
		now,
	).map(stripAnsi);
	assert.match(runningHoursLines[0]!, /stage · review-a · 1h 6m/u);

	const doneLines = injectStageLabelIntoEditorTopRule(
		emptyHostCtx,
		"review-a",
		baseLines,
		{ id: "stage-a", name: "review-a", status: "completed", parentIds: [], toolEvents: [] } as never,
		now,
	).map(stripAnsi);
	assert.match(doneLines[0]!, /stage · review-a · done/u);
	assert.match(doneLines[1]!, /Message review-a…/u);
});
