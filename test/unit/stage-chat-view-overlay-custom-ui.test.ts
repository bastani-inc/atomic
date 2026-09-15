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
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionnaireResult } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/ui-surface.js";
import {
	applyStageLabelToEditorTopRule,
	applyStageLabelToWidgetTopRule,
} from "../../packages/workflows/src/tui/stage-input-label.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
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

	test("labels a mounted QuestionnaireSession DynamicBorder top rule exactly once", async () => {
		initTheme("dark");
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const broker = new StageUiBroker(store);
		const view = makeOverlayStageChatView(broker, store, [assistantTextMessage("EARLIER-HISTORY-MARKER")]);
		const params = {
			questions: [
				{
					question: "Which channel?",
					header: "Choice",
					options: [
						{ label: "Alpha", description: "First option" },
						{ label: "Beta", description: "Second option" },
					],
				},
			],
		};
		const pending = broker.requestCustomUi<QuestionnaireResult>(
			"run-1",
			"stage-a",
			(_tui, _theme, _kb, done): PiCustomComponent => {
				const session = new QuestionnaireSession({
					tui: { terminal: { columns: 100 }, requestRender() {} },
					theme,
					params,
					itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
					done: done as (result: QuestionnaireResult) => void,
				});
				return session.component;
			},
			QUESTIONNAIRE_OPTIONS,
		);
		await flush();

		const first = view.render(100).map(stripAnsi);
		const second = view.render(100).map(stripAnsi);
		const labeled = first.filter((line) => line.includes("[stage: review-a]"));
		assert.equal(labeled.length, 1, `expected one stage label:\n${first.join("\n")}`);
		assert.match(labeled[0]!, /^\[stage: review-a\]─+$/);
		assert.equal(visibleWidth(labeled[0]!), 100);
		assert.equal(
			second.filter((line) => line.includes("[stage: review-a]")).length,
			1,
			"repaint must not duplicate the stage label",
		);
		assert.ok(first.join("\n").includes("Which channel?"));
		assert.ok(first.join("\n").includes("Choice"));
		assert.ok(first.join("\n").includes("Alpha"));
		assert.ok(first.join("\n").includes("Beta"));
		assert.ok(first.join("\n").includes("EARLIER-HISTORY-MARKER"));
		assert.ok(first.some((line) => line.includes("ctrl+x")));

		assert.equal(view.handleInput("\x1b[B"), true);
		view.handleInput("\r");
		const result = await pending;
		assert.equal(result.cancelled, false);
		assert.equal(result.answers[0]?.answer, "Beta");
		assert.equal(store.runs()[0]?.stages[0]?.status, "running");
		assert.doesNotMatch(stripAnsi(view.render(100).join("\n")), /Which channel\?/);
		view.dispose();
	});

	test("widget stage labels ignore titled, narrower, and unrelated first rows", () => {
		const themeTokens = deriveGraphTheme({});
		const titled = `╭ Title ${"─".repeat(50)}╮`;
		const unrelated = "+ ordinary text";
		const narrow = "─".repeat(30);
		const pure = "─".repeat(80);
		const boxed = `╭${"─".repeat(78)}╮`;

		assert.equal(applyStageLabelToWidgetTopRule(themeTokens, "review-a", [titled, "body"], 80)[0], titled);
		assert.equal(applyStageLabelToWidgetTopRule(themeTokens, "review-a", [unrelated, "body"], 80)[0], unrelated);
		assert.equal(applyStageLabelToWidgetTopRule(themeTokens, "review-a", [narrow, "body"], 80)[0], narrow);

		const labeledPure = applyStageLabelToWidgetTopRule(themeTokens, "review-a", [pure, "body"], 80);
		assert.match(stripAnsi(labeledPure[0]!), /^\[stage: review-a\]─+$/);
		assert.equal(visibleWidth(stripAnsi(labeledPure[0]!)), 80);
		assert.equal(labeledPure[1], "body");
		assert.deepEqual(applyStageLabelToWidgetTopRule(themeTokens, "review-a", labeledPure, 80), labeledPure);

		const labeledBox = applyStageLabelToWidgetTopRule(themeTokens, "review-a", [boxed, "body"], 80);
		assert.match(stripAnsi(labeledBox[0]!), /^╭\[stage: review-a\]─+╮$/);
		assert.equal(visibleWidth(stripAnsi(labeledBox[0]!)), 80);
	});

	test("editor stage labels stay on the first dash rule across repeated transforms", () => {
		const themeTokens = deriveGraphTheme({});
		const color = "\x1b[38;2;1;2;3m";
		const rule = `${color}${"─".repeat(80)}\x1b[0m`;
		const content = "❯ label-check";
		const first = applyStageLabelToEditorTopRule(themeTokens, "review-a", [rule, content, rule]);
		assert.match(stripAnsi(first[0]!), /^\[stage: review-a\] ─+$/);
		assert.equal(visibleWidth(stripAnsi(first[0]!)), 80);
		assert.equal(first[1], content);
		assert.equal(stripAnsi(first[2]!), "─".repeat(80));
		const again = applyStageLabelToEditorTopRule(themeTokens, "review-a", first);
		assert.equal((stripAnsi(again.join("\n")).match(/\[stage:/g) ?? []).length, 1);
		assert.equal(stripAnsi(again[2]!), "─".repeat(80));

		const short = applyStageLabelToEditorTopRule(themeTokens, "review-a", ["─".repeat(39), content, "─".repeat(80)]);
		assert.equal(stripAnsi(short[0]!), "─".repeat(39));
		assert.equal(stripAnsi(short[2]!), "─".repeat(80));

		const unicode = applyStageLabelToEditorTopRule(themeTokens, "审查-é-👩‍💻", ["─".repeat(60), content]);
		assert.match(stripAnsi(unicode[0]!), /^\[stage: .+\] ─+$/);
		assert.equal(visibleWidth(stripAnsi(unicode[0]!)), 60);
	});
});
