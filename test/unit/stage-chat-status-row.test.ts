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

/** A running stage chat in a 30-row terminal; its session, when given, has usage to show. */
function stageChat(
	agentSession?: AgentSession,
	messages: AgentSession["messages"] = [],
): { view: StageChatView; emit: Emit } {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle, state, emit } = makeHandle(undefined, messages, "running", agentSession);
	state.isStreaming = agentSession !== undefined;
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

for (const [event, status] of [
	[{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "overloaded" }, "retrying…"],
	[{ type: "model_fallback_start", from: "a", to: "b", reason: "quota", attempt: 1 }, "switching model…"],
] as const) {
	test(`a stage chat shows \`${status}\` as its status line on the usage row above the composer`, () => {
		const { view, emit } = stageChat(fakeFooterAgentSession(true));
		try {
			emit({ type: "agent_start" } as never);
			emit(event as never);
			for (const width of [80, 160]) {
				const [gap, line, usage] = rowsAboveComposer(view, width);
				assert.equal(gap, "", `${width} columns: a blank row above the status line`);
				assert.match(line ?? "", new RegExp(`^ ∀ ${status}`, "u"), `${width} columns: the status line`);
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
