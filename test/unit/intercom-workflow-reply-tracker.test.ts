import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import {
	bindWorkflowReplyTracker,
	preserveWorkflowReplyTracker,
} from "../../packages/intercom/workflow-reply-tracker.js";

const sender: SessionInfo = {
	id: "sender-1",
	name: "reviewer",
	cwd: "/repo",
	model: "test",
	pid: 1,
	startedAt: 1,
	lastActivity: 1,
};
const message: Message = {
	id: "message-1",
	timestamp: 1,
	expectsReply: true,
	content: { text: "please reply" },
};

function stageContext(boundary: WorkflowStageAdmissionBoundary): ExtensionContext {
	return {
		orchestrationContext: {
			kind: "workflow-stage",
			workflowRunId: "run-1",
			workflowStageId: "stage-1",
			workflowStageName: "review",
			constraints: { disableWorkflowTool: true },
			messageAdmission: {
				boundary,
				extensionState: new Map(),
				isOpen: () => boundary.isOpen(),
			},
		},
	} as ExtensionContext;
}

test("model-fallback sessions share Intercom reply correlation for the stage generation", () => {
	const boundary = new WorkflowStageAdmissionBoundary();
	const context = stageContext(boundary);
	const primary = bindWorkflowReplyTracker(context, new ReplyTracker());
	const incoming = primary.recordIncomingMessage(sender, message);
	primary.queueTurnContext(incoming);

	const fallback = bindWorkflowReplyTracker(context, new ReplyTracker());
	assert.equal(fallback, primary);
	fallback.beginTurn();
	assert.equal(fallback.resolveReplyTarget({}).message.id, message.id);
	assert.equal(preserveWorkflowReplyTracker(context), true);

	boundary.seal();
	assert.equal(preserveWorkflowReplyTracker(context), false);
});

test("replyTo selects an exact ask when one sender has concurrent pending questions", () => {
	const tracker = new ReplyTracker();
	tracker.recordIncomingMessage(sender, message);
	tracker.recordIncomingMessage(sender, { ...message, id: "message-2" });

	assert.equal(tracker.resolveReplyTarget({ replyTo: "message-2" }).message.id, "message-2");
	assert.equal(tracker.resolveReplyTarget({ to: "reviewer", replyTo: "message-1" }).message.id, "message-1");
	assert.throws(() => tracker.resolveReplyTarget({ to: "another-session", replyTo: "message-1" }), /not from/);
});

test("a non-pending replyTo falls back to the active turn context", () => {
	const tracker = new ReplyTracker();
	const context = tracker.recordIncomingMessage(sender, { ...message, id: "plain", expectsReply: false });
	tracker.queueTurnContext(context);
	tracker.beginTurn();
	assert.equal(tracker.resolveReplyTarget({ replyTo: "stale-thread" }), context);
});

test("parallel children keep every parent-targeted ask independently addressable", () => {
	const tracker = new ReplyTracker();
	const childA = { ...sender, id: "child-a", name: "child-a" };
	const childB = { ...sender, id: "child-b", name: "child-b" };
	tracker.recordIncomingMessage(childA, { ...message, id: "a-1" }, 1);
	tracker.recordIncomingMessage(childB, { ...message, id: "b-1" }, 2);
	tracker.recordIncomingMessage(childA, { ...message, id: "a-2" }, 3);

	assert.deepEqual(
		tracker.listPending(3).map((context) => context.message.id),
		["a-1", "b-1", "a-2"],
	);
	assert.equal(tracker.resolveReplyTarget({ to: "child-b" }, 3).message.id, "b-1");
	assert.throws(() => tracker.resolveReplyTarget({ to: "child-a" }, 3), /Multiple pending asks/);
	assert.equal(tracker.resolveReplyTarget({ replyTo: "a-2" }, 3).message.id, "a-2");
	tracker.markReplied("a-2");
	assert.deepEqual(
		tracker.listPending(3).map((context) => context.message.id),
		["a-1", "b-1"],
	);
});

test("markReplied removes an exact ask from queued turn contexts", () => {
	const tracker = new ReplyTracker();
	const first = tracker.recordIncomingMessage(sender, message, 1);
	const second = tracker.recordIncomingMessage(sender, { ...message, id: "message-2" }, 2);
	tracker.queueTurnContext(first);
	tracker.queueTurnContext(second);
	tracker.markReplied("message-2");
	tracker.beginTurn(2);
	assert.equal(tracker.resolveReplyTarget({}, 2), first);
	tracker.markReplied("message-1");
	tracker.endTurn();
	tracker.beginTurn(2);
	assert.throws(() => tracker.resolveReplyTarget({}, 2), /No active intercom context/);
});
