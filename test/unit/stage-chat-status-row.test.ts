import { test } from "vitest";
import {
	type AgentSession,
	assert,
	assistantTextMessage,
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	makeHandle,
	makeTestTui,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

type Emit = ReturnType<typeof makeHandle>["emit"];

/** A running stage chat in a 30-row terminal; its session, when given, has usage to show and streams unless told not to. */
function stageChat(
	agentSession?: AgentSession,
	messages: AgentSession["messages"] = [],
	streaming = agentSession !== undefined,
): { view: StageChatView; emit: Emit } {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle, state, emit } = makeHandle(undefined, messages, "running", agentSession);
	state.isStreaming = streaming;
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(30),
	});
	return { view, emit };
}

/** The rows from the status line through the composer's labelled top rule, whichever rule glyph the composer draws. */
function rowsAboveComposer(view: StageChatView, width: number): string[] {
	const rows = view.render(width).map((row) => stripAnsi(row).trimEnd());
	const rule = rows.findIndex((row) => /^[─━]+ stage · review-a · .+ [─━]$/u.test(row));
	assert.ok(rule >= 3, `the composer's labelled top rule is painted:\n${rows.join("\n")}`);
	return rows.slice(rule - 3, rule + 1);
}

test("a working stage chat puts its working line directly on the usage row above the composer", () => {
	const { view, emit } = stageChat(fakeFooterAgentSession(true));
	try {
		emit({ type: "agent_start" } as never);
		for (const width of [80, 160]) {
			const [gap, status, usage, rule] = rowsAboveComposer(view, width);
			assert.equal(gap, "", `${width} columns: a blank row above the status line`);
			assert.match(status ?? "", /^ ∀ /u, `${width} columns: the working line`);
			assert.match(usage ?? "", /\(auto\)$/u, `${width} columns: the usage row on the working line`);
			assert.match(rule ?? "", /stage · review-a/u);
		}
	} finally {
		view.dispose();
	}
});

test("a stage chat without usage to show keeps one blank row on the composer's top rule", () => {
	// A transcript taller than the view, so the row above the rule is the layout's own blank row and not empty transcript.
	const answer = Array.from({ length: 40 }, (_, index) => `answer line ${index + 1}`).join("\n\n");
	const { view } = stageChat(undefined, [assistantTextMessage(answer)]);
	try {
		for (const width of [80, 160]) {
			const [, last, blank] = rowsAboveComposer(view, width);
			assert.equal(blank, "", `${width} columns: a blank row in the usage row's place`);
			assert.equal(last, " answer line 40", `${width} columns: the transcript ends right above that row`);
		}
	} finally {
		view.dispose();
	}
});

for (const [event, status, statusLine] of [
	[
		{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 60_000, errorMessage: "overloaded" },
		"Retrying · overloaded · attempt 1/3",
		/^ ∀ Retrying · overloaded · attempt 1\/3 in (?:1m 0s|59s) {3}esc cancel$/u,
	],
	[
		{ type: "model_fallback_start", from: "a", to: "b", reason: "quota", attempt: 1 },
		"Switching model…",
		/^ ∀ Switching model…$/u,
	],
] as const) {
	test(`a stage chat shows \`${status}\` as its status line on the usage row above the composer`, () => {
		const { view, emit } = stageChat(fakeFooterAgentSession(true));
		try {
			emit({ type: "agent_start" } as never);
			emit(event as never);
			for (const width of [80, 160]) {
				const [gap, line, usage] = rowsAboveComposer(view, width);
				assert.equal(gap, "", `${width} columns: a blank row above the status line`);
				assert.match(line ?? "", statusLine, `${width} columns: the status line`);
				assert.match(usage ?? "", /\(auto\)$/u, `${width} columns: the usage row`);
				const shown = view
					.render(width)
					.map((row) => stripAnsi(row))
					.filter((row) => row.includes(status));
				assert.equal(shown.length, 1, `${width} columns: \`${status}\` is not repeated below the transcript`);
			}
		} finally {
			view.dispose();
		}
	});
}

/** A stage session between two attempts: its retry has started and its next attempt has not. */
function waitingToRetry(): AgentSession {
	return Object.assign(fakeFooterAgentSession(false), { retryAttempt: 1 });
}

test("a stage chat opened while its agent waits to retry shows `Retrying…` on the usage row until the next attempt (#5483)", () => {
	const { view, emit } = stageChat(waitingToRetry(), [], false);
	try {
		for (const width of [80, 160]) {
			const [gap, line, usage] = rowsAboveComposer(view, width);
			assert.equal(gap, "", `${width} columns: a blank row above the status line`);
			// A session that does not publish its wait's details shows the plain line; Esc pauses the stage.
			assert.equal(line, " ∀ Retrying…   esc cancel", `${width} columns: the retry is the status line`);
			assert.match(usage ?? "", /\(auto\)$/u, `${width} columns: right on the usage row`);
		}
		emit({ type: "agent_start" } as never);
		for (const width of [80, 160]) {
			const [, line] = rowsAboveComposer(view, width);
			assert.match(line ?? "", /^ ∀ /u, `${width} columns: the next attempt is the working line`);
			assert.doesNotMatch(line ?? "", /Retrying/u, `${width} columns: the next attempt clears the retry`);
		}
	} finally {
		view.dispose();
	}
});

test("a stage chat opened while its agent waits to retry stops showing it when the retry ends (#5483)", () => {
	const { view, emit } = stageChat(waitingToRetry(), [], false);
	try {
		const shows = () => view.render(80).some((row) => stripAnsi(row).includes("Retrying…"));
		assert.ok(shows(), "the retry wait is shown");
		emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" } as never);
		assert.ok(!shows(), "the retry's end clears it");
	} finally {
		view.dispose();
	}
});

test("an open stage chat stops showing a retry when its worker attempt is fenced (#5572)", () => {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle, emit } = makeHandle();
	const worker = Object.assign(handle, {
		placement: { kind: "local-worker" as const, workId: "work", generation: 1, reconnecting: false },
	});
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test",
		handle: worker,
		onDetach() {},
		onClose() {},
		piTui: makeTestTui(30),
	});
	const retrying = (chat: StageChatView) =>
		chat.render(80).some((row) => stripAnsi(row).includes("Retrying · busy · attempt 1/1"));
	try {
		emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 2000, errorMessage: "busy" });
		assert.equal(retrying(view), true);
		worker.placement.reconnecting = true;
		assert.equal(retrying(view), false);
	} finally {
		view.dispose();
	}
});

test("a chat on another host updates the retry line from the stage publication without receiving session events (#5572)", () => {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle } = makeHandle();
	const publish = (chatActivity: "working" | "switching") =>
		store.editRun("run-1", (run) => {
			run.stages[0]!.chatActivity = chatActivity;
			return { stageIds: ["stage-a"] };
		});
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test",
		handle: Object.assign(handle, { publishedActivity: "retrying" as const }),
		onDetach() {},
		onClose() {},
		piTui: makeTestTui(30),
	});
	const line = () =>
		view
			.render(80)
			.map(stripAnsi)
			.find((row) => row.includes("∀"))
			?.trim();
	try {
		assert.equal(line(), "∀ Retrying…");
		publish("switching");
		assert.equal(line(), "∀ Switching model…");
		publish("working");
		assert.equal(line(), "∀ Working…");
		store.editRun("run-1", (run) => {
			const stage = run.stages[0]!;
			stage.workerExecution = { worker: "satellite", generation: 1, renewedAt: 0, expiresAt: 100 };
			delete stage.chatActivity;
			return { stageIds: [stage.id] };
		});
		assert.equal(
			line(),
			undefined,
			"a worker that stopped reporting live activity does not restart the initial wait",
		);
		store.recordStagePaused("run-1", "stage-a");
		assert.equal(line(), undefined);
	} finally {
		view.dispose();
	}
});

test("a chat opened while a stage on a local worker waits to retry shows `Retrying…` above the composer (#5483)", () => {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	// No session in this process: the stage's handle says whether its session waits to retry.
	const { handle } = makeHandle(undefined, [], "running");
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle: Object.assign(handle, { isWaitingToRetry: true }),
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(30),
	});
	try {
		for (const width of [80, 160]) {
			const [gap, line, blank] = rowsAboveComposer(view, width);
			assert.equal(gap, "", `${width} columns: a blank row above the status line`);
			assert.equal(line, " ∀ Retrying…   esc cancel", `${width} columns: the retry is the status line`);
			assert.equal(blank, "", `${width} columns: the blank row in the usage row's place`);
		}
	} finally {
		view.dispose();
	}
});
