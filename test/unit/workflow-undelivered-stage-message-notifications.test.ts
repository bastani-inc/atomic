import assert from "node:assert/strict";
import { test } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	formatUndeliveredStageMessageNoticeText,
	installUndeliveredStageMessageNotifications,
	registerUndeliveredStageMessageRenderer,
	UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE,
} from "../../packages/workflows/src/extension/undelivered-stage-message-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageNotice } from "../../packages/workflows/src/shared/store-types.js";
import { noticeSummary, stageNoticeLine } from "../../packages/workflows/src/tui/stage-chat-view-transcript.js";

function storeWithStage() {
	const store = createStore();
	store.recordRunStart({
		id: "run-1",
		name: "review",
		inputs: {},
		status: "running",
		startedAt: 1,
		stages: [],
		toolNodes: [],
	});
	store.recordStageStart("run-1", {
		id: "stage-1",
		name: "agent",
		status: "completed",
		parentIds: [],
		toolEvents: [],
	});
	return store;
}

function undelivered(id: string, text: string): StageNotice {
	return { id, ts: 2, kind: "undelivered", to: text };
}

type Sent = { readonly message: { customType: string; content: string; display: boolean }; readonly options: object };

test("each undelivered stage message tells the parent session once, naming the message and the stage (#4884)", () => {
	const store = storeWithStage();
	const sent: Sent[] = [];
	const stop = installUndeliveredStageMessageNotifications({
		store,
		sendMessage: (message, options) => {
			sent.push({ message: message as Sent["message"], options: options ?? {} });
		},
	});
	store.recordStageNotice("run-1", "stage-1", undelivered("n-1", "please also check the tests"));
	store.recordStageNotice("run-1", "stage-1", { id: "n-2", ts: 3, kind: "model", to: "other" });
	store.recordStageNotice("run-1", "stage-1", { id: "n-3", ts: 4, kind: "compaction", to: "compacted" });
	stop();
	store.recordStageNotice("run-1", "stage-1", undelivered("n-4", "after uninstall"));
	assert.equal(sent.length, 1, JSON.stringify(sent));
	assert.equal(sent[0]!.message.customType, UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE);
	assert.equal(sent[0]!.message.display, true);
	assert.deepEqual(sent[0]!.options, { triggerTurn: false, deliverAs: "nextTurn" });
	assert.equal(
		sent[0]!.message.content,
		'✗ Stage "agent" of workflow "review" (run run-1) finished before this message was delivered: "please also check the tests". Send it to another stage if it still matters.',
	);
});

test("notices that existed before the parent session listened are not told again (#4884)", () => {
	const store = storeWithStage();
	store.recordStageNotice("run-1", "stage-1", undelivered("n-1", "earlier"));
	const sent: unknown[] = [];
	const stop = installUndeliveredStageMessageNotifications({
		store,
		sendMessage: (message) => void sent.push(message),
	});
	store.recordStageNotice("run-1", "stage-1", undelivered("n-2", "later"));
	stop();
	assert.equal(sent.length, 1);
	assert.match((sent[0] as { content: string }).content, /"later"/);
});

test("a long undelivered message is shortened to one line in the notice (#4884)", () => {
	const text = formatUndeliveredStageMessageNoticeText({
		runId: "r",
		workflowName: "w",
		stageId: "s",
		stageName: "agent",
		text: `first\n${"x".repeat(400)}`,
		noticeId: "n",
	});
	const quoted = JSON.parse(text.slice(text.indexOf(': "') + 2, text.lastIndexOf(". Send"))) as string;
	assert.equal(quoted.length, 240);
	assert.ok(quoted.startsWith("first x"));
	assert.ok(quoted.endsWith("…"));
});

test("the parent session's renderer is registered once per host and draws a card naming the message and stage (#4884)", () => {
	const host = {};
	const registered: { event: string; renderer: (raw: unknown, options: unknown, theme: unknown) => unknown }[] = [];
	const register = {
		rendererHost: host,
		registerMessageRenderer(event: string, renderer: (raw: unknown, options: unknown, theme: unknown) => unknown) {
			registered.push({ event, renderer });
		},
	};
	registerUndeliveredStageMessageRenderer(register as never);
	registerUndeliveredStageMessageRenderer(register as never);
	assert.equal(registered.length, 1);
	assert.equal(registered[0]!.event, UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE);
	assert.equal(registered[0]!.renderer({}, {}, undefined), undefined);
	initTheme("dark");
	const render = (expanded: boolean, width: number, outputPad?: number) =>
		(
			registered[0]!.renderer(
				{
					details: {
						runId: "run-1",
						workflowName: "review",
						stageId: "s",
						stageName: "agent",
						text: "check the tests",
						noticeId: "n",
					},
				},
				{ expanded, ...(outputPad === undefined ? {} : { outputPad }) },
				undefined,
			) as { render(width: number): string[] }
		)
			.render(width)
			.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	const collapsed = render(false, 100);
	assert.equal(collapsed[0], ' ! Stage "agent" finished before this message was delivered · review');
	assert.match(collapsed[1] ?? "", /^ {3}⎿ {2}… \+3 lines(?: \(.+ to expand\))?$/, "hidden details are counted");
	assert.equal(collapsed.length, 2);
	assert.deepEqual(render(true, 100), [
		' ! Stage "agent" finished before this message was delivered · review',
		"   ⎿  run run-1",
		"      message check the tests",
		"      Send it to another stage if it still matters.",
	]);
	for (const line of render(true, 20)) assert.ok(line.length <= 20, "a narrow chat shortens the notice");
	for (const outputPad of [0, 1, 4]) {
		const lines = render(true, 100 + outputPad, outputPad);
		assert.match(lines[0] ?? "", new RegExp(`^ {${outputPad}}! Stage`), "the notice starts at the output pad");
		assert.deepEqual(
			lines.map((line) => line.slice(outputPad)),
			render(true, 100, 0),
		);
	}
});

test("the stage chat shows an undelivered message as a warning notice naming it (#4884)", () => {
	const notice: StageNotice = { id: "n", ts: 1, kind: "undelivered", to: "check the tests" };
	assert.equal(noticeSummary(notice), '~ not delivered, the stage finished first: "check the tests"');
	const line = stageNoticeLine({
		role: "notice",
		text: noticeSummary(notice),
		noticeId: "n",
		kind: "undelivered",
		value: "check the tests",
	});
	assert.equal(line.status, "warning");
	assert.equal(`${line.label} ${line.outcome}`, "Stage finished before this message was delivered");
	assert.equal(line.detail, "message check the tests\nSend it to another stage if it still matters.");
});

test("the parent session's renderer registers once per registrar when no host is named (#4884)", () => {
	const registered: string[] = [];
	const registrar = {
		registerMessageRenderer(event: string) {
			registered.push(event);
		},
	};
	registerUndeliveredStageMessageRenderer(registrar as never);
	registerUndeliveredStageMessageRenderer(registrar as never);
	assert.deepEqual(registered, [UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE]);
});

test("the notice keeps a message of exactly the limit whole and folds its whitespace (#4884)", () => {
	const notice = (text: string) =>
		formatUndeliveredStageMessageNoticeText({
			runId: "r",
			workflowName: "w",
			stageId: "s",
			stageName: "agent",
			text,
			noticeId: "n",
		});
	const exact = "y".repeat(240);
	assert.match(notice(exact), new RegExp(`"${exact}"`));
	assert.match(notice("  one\n\ttwo  "), /: "one two"\./);
});
