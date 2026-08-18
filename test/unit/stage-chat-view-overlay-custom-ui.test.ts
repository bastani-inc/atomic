/**
 * Overlay-mode custom UI in the attached stage chat.
 *
 * `ask_user_question` always asks its host for `{ overlay: true,
 * reserveTranscriptRows: true, overlayOptions: … }`. Inside a workflow stage
 * that call is routed to `stageUiBroker.requestCustomUi`, and the graph host
 * used to reject it outright ("ctx.ui.custom overlay mode is unavailable in the
 * workflow graph viewer"), so the questionnaire never appeared and the stage
 * failed. Overlay is a placement hint, not a capability request: the stage-chat
 * custom-UI slot mounts it on the ordinary path, keeping the transcript visible
 * behind it.
 *
 * cross-ref: packages/workflows/src/tui/stage-chat-view-custom-ui.ts
 */

import { describe, test } from "vitest";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/ui-surface.js";
import {
	type AgentSession,
	assert,
	assistantTextMessage,
	createStore,
	deriveGraphTheme,
	flush,
	makeFakeKeybindings,
	makeHandle,
	makeTestTui,
	StageChatView,
	StageUiBroker,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

const REJECTION_MESSAGE = "overlay mode is unavailable";

/** The exact options `ask_user_question` passes through `ctx.ui.custom`. */
const QUESTIONNAIRE_OPTIONS = {
	overlay: true,
	overlayOptions: { anchor: "bottom-center", width: "100%" },
} as const;

function makeOverlayStageChatView(
	broker: StageUiBroker,
	store: ReturnType<typeof createStore>,
	messages: AgentSession["messages"] = [],
): StageChatView {
	const { handle } = makeHandle(undefined, messages);
	return new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(32),
		piTheme: {},
		piKeybindings: makeFakeKeybindings(),
		stageUiBroker: broker,
	});
}

describe("StageChatView overlay custom UI", () => {
	test("mounts an overlay custom UI request instead of rejecting it", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const broker = new StageUiBroker(store);
		const view = makeOverlayStageChatView(broker, store);

		const pending = broker.requestCustomUi(
			"run-1",
			"stage-a",
			(_tui, _theme, _kb, done): PiCustomComponent => ({
				render: () => ["OVERLAY-QUESTION"],
				handleInput: () => {
					done("Alpha");
					return true;
				},
				invalidate: () => {},
			}),
			{ overlay: true },
		);
		await flush();

		assert.equal(store.runs()[0]?.stages[0]?.status, "awaiting_input");
		assert.match(stripAnsi(view.render(80).join("\n")), /OVERLAY-QUESTION/);

		view.handleInput("enter");
		assert.equal(await pending, "Alpha");
		assert.equal(store.runs()[0]?.stages[0]?.status, "running");
		view.dispose();
	});

	test("mounts ask_user_question's own overlay options and keeps the transcript visible", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const broker = new StageUiBroker(store);
		const view = makeOverlayStageChatView(broker, store, [assistantTextMessage("EARLIER-HISTORY-MARKER")]);

		const received: string[] = [];
		const pending = broker.requestCustomUi(
			"run-1",
			"stage-a",
			(_tui, _theme, _kb, done): PiCustomComponent => ({
				render: () => ["GRAPH-OVERLAY-QUESTION", "Alpha", "Beta"],
				handleInput: (data: string) => {
					received.push(data);
					if (data === "\r") done({ answers: [{ question: "GRAPH-OVERLAY-QUESTION", answer: "Beta" }] });
					return true;
				},
				invalidate: () => {},
			}),
			QUESTIONNAIRE_OPTIONS,
		);
		await flush();

		const rendered = stripAnsi(view.render(80).join("\n"));
		assert.doesNotMatch(rendered, new RegExp(REJECTION_MESSAGE));
		assert.match(rendered, /GRAPH-OVERLAY-QUESTION/);
		assert.match(rendered, /Alpha/);
		assert.match(rendered, /Beta/);
		assert.match(rendered, /EARLIER-HISTORY-MARKER/);

		// Navigation keys reach the mounted questionnaire, and answering resolves
		// the awaiting stage exactly as a non-overlay custom UI does.
		assert.equal(view.handleInput("j"), true);
		view.handleInput("\r");
		assert.deepEqual(await pending, { answers: [{ question: "GRAPH-OVERLAY-QUESTION", answer: "Beta" }] });
		assert.deepEqual(received, ["j", "\r"]);
		assert.equal(store.runs()[0]?.stages[0]?.status, "running");
		assert.doesNotMatch(stripAnsi(view.render(80).join("\n")), /GRAPH-OVERLAY-QUESTION/);
		view.dispose();
	});
});
