import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionnaireResult } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/ui-surface.ts";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.ts";
import { createStore } from "../../packages/workflows/src/shared/store.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.ts";
import { getStageEscapeInterruptState } from "../../packages/workflows/src/tui/stage-chat-view-state.ts";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.ts";
import { taskRecord } from "../helpers/task-record.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";
import { makeTestTui } from "../support/fake-tui.ts";
import {
	fakeFooterAgentSession,
	flush,
	makeHandle,
	makePendingPrompt,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.ts";

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

test("Left and Backspace leave a mounted ask_user_question pending with ← graph in its hint, and reopening restores it (#5224)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const broker = new StageUiBroker(store);
	const { handle } = makeHandle();
	let detached = 0;
	const makeView = () =>
		new StageChatView({
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
			piTui: makeTestTui(32),
			piTheme: theme,
			piKeybindings: keys,
			stageUiBroker: broker,
		});
	const params = {
		questions: [
			{
				question: "Approve the shipping plan?",
				header: "Plan",
				options: [
					{ label: "Yes", description: "Ship it as planned" },
					{ label: "No, revise", description: "Rework the plan first" },
				],
			},
		],
	};
	let settled: QuestionnaireResult | undefined;
	const pending = broker.requestCustomUi<QuestionnaireResult>(
		"run-1",
		"stage-a",
		(_tui, _theme, _kb, done): PiCustomComponent => {
			const session = new QuestionnaireSession({
				tui: { terminal: { columns: 100 }, requestRender() {} },
				theme,
				params,
				itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
				done: (result) => {
					settled = result;
					(done as (value: QuestionnaireResult) => void)(result);
				},
			});
			return session.component;
		},
		{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } },
	);
	void pending.then((value) => {
		settled = value;
	});

	const view1 = makeView();
	try {
		await flush();
		const frame1 = stripAnsi(view1.render(100).join("\n"));
		assert.match(frame1, /Approve the shipping plan\?/u);
		assert.match(frame1, /↑↓ select · enter choose · esc cancel · ← graph/u);
		assert.equal(view1.handleInput("\x1b[D"), true);
		await flush();
		assert.equal(detached, 1, "Left detaches from a mounted ask_user_question");
		assert.equal(settled, undefined, "Left leaves ask_user_question pending");
		assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");
	} finally {
		view1.dispose();
	}

	const view2 = makeView();
	try {
		await flush();
		const frame2 = stripAnsi(view2.render(100).join("\n"));
		assert.match(frame2, /Approve the shipping plan\?/u);
		assert.equal(view2.handleInput("\x7f"), true);
		await flush();
		assert.equal(detached, 2, "Backspace also detaches from a mounted ask_user_question");
		assert.equal(settled, undefined, "Backspace leaves ask_user_question pending");
		assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");
	} finally {
		view2.dispose();
	}

	const view3 = makeView();
	try {
		await flush();
		assert.match(stripAnsi(view3.render(100).join("\n")), /Approve the shipping plan\?/u);
		assert.equal(view3.handleInput("\r"), true);
		const result = await pending;
		assert.equal(result.cancelled, false);
		assert.equal(result.answers[0]?.answer, "Yes");
		assert.equal(store.runs()[0]?.stages[0]?.status, "running");
	} finally {
		view3.dispose();
		setKeybindings(previous);
	}
});

test("Esc in a running stage prints the shared past-tense end row in dim color and re-entering suppresses the stale PAUSED banner (#5224)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	let now = 10_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.spyOn(Math, "random").mockReturnValue(0);

	const store = createStore();
	setupRun(store, "run-1", "stage-a", "running");
	let streaming = true;
	const handleMessages: unknown[] = [];
	const { handle, emit } = makeHandle(
		{
			promptCalls: [],
			steerCalls: [],
			followUpCalls: [],
			pauseCalls: 0,
			resumeCalls: [],
			get isStreaming() {
				return streaming;
			},
		} as never,
		handleMessages as never,
		"running",
		fakeFooterAgentSession(true),
	);
	const origPause = handle.pause.bind(handle);
	Object.assign(handle, {
		async pause() {
			streaming = false;
			await origPause();
			store.recordStagePaused("run-1", "stage-a");
		},
	});
	const graphTheme = deriveGraphTheme({});
	const makeView = () =>
		new StageChatView({
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
			piKeybindings: keys,
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		});

	const view1 = makeView();
	try {
		emit({ type: "agent_start" } as never);
		emit({ type: "turn_start" } as never);
		now = 16_000;
		assert.equal(view1.handleInput("\x1b"), true);
		await flush();
		const aborted = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 800,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 800,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: "Operation aborted",
			timestamp: 16_000,
		};
		handleMessages.push(aborted);
		emit({ type: "message_end", message: aborted } as never);
		emit({ type: "agent_end", messages: [aborted] } as never);
		await flush();

		const rawLines1 = view1.render(100);
		const plainLines1 = rawLines1.map(stripAnsi);
		const plainText1 = plainLines1.join("\n");
		assert.match(plainText1, /◼ Interrupted/u);
		assert.match(plainText1, /∀ \w+ed for 6s · ↓ 800 tokens/u, "interrupted stage prints shared past-tense end row");
		const endRowRaw = rawLines1.find((line) => /∀ \w+ed for 6s/.test(stripAnsi(line))) ?? "";
		assert.match(endRowRaw, /\x1b\[38;2;/u, "past-tense end row is styled with dim color");
		assert.doesNotMatch(plainText1, /❚❚\s+PAUSED|This workflow stage is paused/u);
	} finally {
		view1.dispose();
	}

	const view2 = makeView();
	try {
		await flush();
		const plainLines2 = view2.render(100).map(stripAnsi);
		const plainText2 = plainLines2.join("\n");
		assert.doesNotMatch(
			plainText2,
			/❚❚\s+PAUSED|This workflow stage is paused|enter resumes · ← return to graph/u,
			"re-entering stage paused by Esc does not restore the old PAUSED banner",
		);
		assert.match(plainText2, /◼ Interrupted/u);
		assert.match(plainText2, /∀ \w+ed for 6s · ↓ 800 tokens/u);
		assert.ok(getStageEscapeInterruptState({ store, runId: "run-1", stageId: "stage-a" }) !== undefined);

		// When the stage resumes or finishes, the store-scoped interrupted entry is pruned
		store.recordStageResumed("run-1", "stage-a");
		assert.equal(getStageEscapeInterruptState({ store, runId: "run-1", stageId: "stage-a" }), undefined);
	} finally {
		view2.dispose();
		vi.restoreAllMocks();
		setKeybindings(previous);
	}
});

test("blocked stage chat hint lists only live keys and omits dead ? keys and ↓ agents (#5224)", () => {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "blocked");
	const tasks = new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }));
	const shell = { ...taskRecord("build", "command"), title: "npm test" };
	tasks.apply({
		tasks: [shell],
		background: [shell.ref.taskId],
		settlement: [],
		activity: [],
		stdin: [],
		statuses: [],
	});
	const { handle: base } = makeHandle();
	let detached = 0;
	let expanded = false;
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "wf",
		handle: {
			...base,
			placement: { kind: "local-worker", workId: "work", generation: 1 },
			taskSource: () => tasks,
		},
		onDetach: () => {
			detached += 1;
		},
		onClose: () => {},
		piTui: makeTestTui(24),
		piTheme: theme,
		piKeybindings: keys,
		getToolsExpanded: () => expanded,
		setToolsExpanded: (next) => {
			expanded = next;
		},
	});
	try {
		const lines = view.render(100).map(stripAnsi);
		assert.equal(lines.at(-1)?.trimEnd(), "  ← graph · pgup/pgdn scroll · ctrl+o expand");
		assert.equal(view.handleInput("?"), true);
		assert.equal(
			view
				.render(100)
				.map(stripAnsi)
				.some((line) => line.includes("keys · stage chat")),
			false,
		);
		assert.equal(view.handleInput("\x1b[B"), true);
		assert.doesNotMatch(view.render(100).map(stripAnsi).join("\n"), /^\s*Tasks\b/m);
		assert.equal(view.handleInput("\x0f"), true);
		assert.equal(expanded, true);
		assert.equal(view.handleInput("\x1b[D"), true);
		assert.equal(detached, 1);
	} finally {
		view.dispose();
		setKeybindings(previous);
	}
});

test("stage chat ← at cursor 0 of a non-empty draft detaches and keeps the draft, while ? and ↓ with a draft do not open overlays (#5224)", () => {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "running");
	const tasks = new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }));
	const shell = { ...taskRecord("build", "command"), title: "npm test" };
	tasks.apply({
		tasks: [shell],
		background: [shell.ref.taskId],
		settlement: [],
		activity: [],
		stdin: [],
		statuses: [],
	});
	const { handle: base } = makeHandle();
	let detached = 0;
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "wf",
		handle: {
			...base,
			placement: { kind: "local-worker", workId: "work", generation: 1 },
			taskSource: () => tasks,
		},
		onDetach: () => {
			detached += 1;
		},
		onClose: () => {},
		piTui: makeTestTui(24),
		piTheme: theme,
		piKeybindings: keys,
	});
	try {
		for (const ch of "hello") view.handleInput(ch);
		assert.equal(view._inputBuffer, "hello");

		// ? with a non-empty draft types into the draft instead of opening help overlay
		assert.equal(view.handleInput("?"), true);
		assert.equal(view._inputBuffer, "hello?");
		assert.equal(
			view
				.render(100)
				.map(stripAnsi)
				.some((line) => line.includes("keys · stage chat")),
			false,
		);

		// ↓ with a non-empty draft does not open the task inspector
		assert.equal(view.handleInput("\x1b[B"), true);
		assert.doesNotMatch(view.render(100).map(stripAnsi).join("\n"), /^\s*Tasks\b/m);

		// ← at the end of a non-empty draft moves the caret without detaching
		assert.equal(view.handleInput("\x1b[D"), true);
		assert.equal(detached, 0);

		// Move caret to start (Ctrl+A), then ← detaches and keeps the draft
		assert.equal(view.handleInput("\x01"), true);
		assert.equal(view.handleInput("\x1b[D"), true);
		assert.equal(detached, 1);
		assert.equal(view._inputBuffer, "hello?");
	} finally {
		view.dispose();
		setKeybindings(previous);
	}
});

test("Left on an input prompt card at start detaches and preserves the prompt draft (#5224)", () => {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const prompt = makePendingPrompt({ kind: "input", message: "Enter release tag:" });
	assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
	const { handle } = makeHandle();
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
		piKeybindings: makeFakeKeybindings(),
	});
	try {
		view.render(100);
		assert.equal(view.handleInput("\x1b[D"), true);
		assert.equal(detached, 1);
		assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.id, prompt.id);
	} finally {
		view.dispose();
	}
});
