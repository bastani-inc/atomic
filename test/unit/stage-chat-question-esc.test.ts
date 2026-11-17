import assert from "node:assert/strict";
import { test } from "vitest";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme, deriveGraphThemeFromPiTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { injectStageLabelIntoEditorTopRule } from "../../packages/workflows/src/tui/stage-chat-view-footer-status.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { makeTestTui } from "../support/fake-tui.js";
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

test("typing into Answer <stage>… after Esc closes a question card resolves valid answers and keeps the closed composer pending with a warning on invalid select/confirm text (#5224)", async () => {
	for (const kind of ["select", "confirm"] as const) {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const prompt = makePendingPrompt({
			kind,
			message: "Ship the plan?",
			...(kind === "select" ? { choices: ["yes", "no"] } : {}),
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

			// Invalid select/confirm answer must NOT settle the pending prompt, reopen the card, or send an ordinary prompt;
			// it preserves the draft, shows the expectation warning, and stays pending across repeated Enter presses.
			for (const ch of "yes ship it") view.handleInput(ch);
			assert.equal(view.handleInput("\r"), true);
			await flush();
			assert.equal(settled, "pending", `${kind}: first invalid Enter must not settle the pending question`);
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);
			assert.equal(view._inputBuffer, "yes ship it", `${kind}: invalid typed text preserves the composer draft`);
			assert.match(view._statusMessage, /Expected/u, `${kind}: invalid Enter shows expectation warning`);

			// A second Enter on the unchanged invalid draft still stays pending and does not accept a default card choice
			assert.equal(view.handleInput("\r"), true);
			await flush();
			assert.equal(settled, "pending", `${kind}: second invalid Enter must still stay pending`);
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);
			assert.equal(view._inputBuffer, "yes ship it");
			assert.deepEqual(
				state.promptCalls,
				[],
				`${kind}: invalid typed text must not be sent as an ordinary stage prompt`,
			);
			assert.deepEqual(state.steerCalls, []);
			assert.equal(detached, 0);

			// Editing to a valid answer ("yes") and pressing Enter resolves the coerced value
			for (let i = 0; i < "yes ship it".length; i++) view.handleInput("\x7f");
			for (const ch of "yes") view.handleInput(ch);
			assert.equal(view.handleInput("\r"), true);
			await flush();

			assert.equal(
				settled,
				kind === "confirm" ? true : "yes",
				`${kind}: valid typed text resolves the coerced answer`,
			);
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt, undefined);
			assert.equal(view._statusMessage, "");
			assert.deepEqual(state.promptCalls, []);
			assert.deepEqual(state.steerCalls, []);
			assert.equal(detached, 1);
		} finally {
			view.dispose();
		}
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

test("StageChatView and deriveGraphThemeFromPiTheme resolve dark and light host Theme tokens instead of fixed Mocha #cdd6f4/#89b4fa/#7f849c (#5239)", () => {
	const fixedMochaSgr = /\x1b\[38;2;(?:205;214;244|137;180;250|127;132;156)m/;
	const renderForTheme = (mode: "dark" | "light") => {
		initTheme(mode);
		const graphTheme = deriveGraphThemeFromPiTheme(theme);
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "running");
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme,
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(24),
			piTheme: theme,
			piKeybindings: makeFakeKeybindings(),
		});
		try {
			const rawLines = view.render(100);
			const topRule = rawLines.find((line) => stripAnsi(line).includes("stage · review-a")) ?? "";
			const placeholderLine = rawLines.find((line) => stripAnsi(line).includes("Message review-a…")) ?? "";
			const hintLine = rawLines.at(-1) ?? "";
			return { graphTheme, topRule, placeholderLine, hintLine };
		} finally {
			view.dispose();
		}
	};

	const dark = renderForTheme("dark");
	const light = renderForTheme("light");
	initTheme("dark");

	assert.equal(dark.graphTheme.accent, "#8abeb7", "dark GraphTheme resolves host accent instead of Mocha #89b4fa");
	assert.equal(light.graphTheme.accent, "#5a8080", "light GraphTheme resolves host accent instead of Mocha #89b4fa");
	assert.equal(dark.graphTheme.dim, "#666666", "dark GraphTheme resolves host dim instead of Mocha #7f849c");
	assert.equal(light.graphTheme.dim, "#767676", "light GraphTheme resolves host dim instead of Mocha #7f849c");

	for (const [name, sample] of [
		["dark", dark],
		["light", light],
	] as const) {
		assert.doesNotMatch(
			sample.topRule,
			fixedMochaSgr,
			`${name}: stage composer rule/label must not use fixed Mocha hex`,
		);
		assert.doesNotMatch(
			sample.placeholderLine,
			fixedMochaSgr,
			`${name}: stage composer placeholder must not use fixed Mocha hex`,
		);
		assert.doesNotMatch(sample.hintLine, fixedMochaSgr, `${name}: stage hint line must not use fixed Mocha hex`);
	}
	assert.notEqual(dark.topRule, light.topRule, "stage composer top rule adapts between dark and light themes");
	assert.notEqual(dark.hintLine, light.hintLine, "stage hint line adapts between dark and light themes");
});
