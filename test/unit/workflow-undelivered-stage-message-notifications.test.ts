import assert from "node:assert/strict";
import { test } from "vitest";
import {
	formatUndeliveredStageMessageNoticeText,
	installUndeliveredStageMessageNotifications,
	UNDELIVERED_STAGE_MESSAGE_CUSTOM_TYPE,
} from "../../packages/workflows/src/extension/undelivered-stage-message-notifications.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageNotice } from "../../packages/workflows/src/shared/store-types.js";

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
