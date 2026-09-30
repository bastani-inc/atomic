import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import type { IntercomClient } from "../../packages/intercom/broker/client.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import {
	bindWorkflowReplyTracker,
	preserveWorkflowReplyTracker,
} from "../../packages/intercom/workflow-reply-tracker.js";
import { toolContext } from "../helpers/tool-context.js";

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

test("explicit reply targets fail closed without redirecting the active ordinary thread", () => {
	const tracker = new ReplyTracker();
	const context = tracker.recordIncomingMessage(sender, { ...message, id: "plain", expectsReply: false });
	tracker.queueTurnContext(context);
	tracker.beginTurn();
	tracker.recordIncomingMessage(sender, message);
	for (const replyTo of ["stale-thread", ""]) {
		assert.throws(() => tracker.resolveReplyTarget({ replyTo }), /No .*reply context/);
	}
	assert.throws(() => tracker.resolveReplyTarget({ to: "" }), /No pending ask/);
	assert.throws(() => tracker.resolveReplyTarget({ to: "other", replyTo: "plain" }), /not from/);
	assert.equal(tracker.resolveReplyTarget({ replyTo: "plain" }), context);
	assert.equal(tracker.resolveReplyTarget({}), context);
	assert.deepEqual(
		tracker.listPending().map((pending) => pending.message.id),
		[message.id],
	);
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

// #3105: inherited workflow context must not grant a child its parent's reply ledger.
test("public pending and reply isolate a workflow parent and two typed children", async () => {
	const parentContext = stageContext(new WorkflowStageAdmissionBoundary());
	const sent: Array<{ owner: string; replyTo?: string }> = [];
	function endpoint(owner: string, context: ExtensionContext) {
		let tracker = bindWorkflowReplyTracker(context, new ReplyTracker());
		let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
		const client = {
			sessionId: owner,
			async send(_to: string, outgoing: { replyTo?: string }) {
				sent.push({ owner, replyTo: outgoing.replyTo });
				return { id: "reply", delivered: true };
			},
		} as IntercomClient;
		const api: Pick<ExtensionAPI, "registerTool" | "appendEntry"> = {
			registerTool: (registered) => {
				tool = registered;
			},
			appendEntry() {},
		};
		registerIntercomTool(api as ExtensionAPI, {
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			homeGroup: () => "default",
			setJoinedGroups() {},
			clearJoinedGroups() {},
			confirmSend: false,
			beginReplyWait: () => {
				throw new Error("unexpected outbound ask");
			},
			replyTracker: () => tracker,
		});
		return {
			receive(id: string) {
				tracker.recordIncomingMessage(sender, { ...message, id });
			},
			rebind() {
				tracker = bindWorkflowReplyTracker(context, tracker);
			},
			async call(action: "pending" | "reply", replyTo?: string) {
				assert.ok(tool);
				const result = await tool.execute(
					"call",
					{ action, message: "answer", ...(replyTo ? { replyTo } : {}) },
					undefined,
					undefined,
					toolContext({
						...context,
						sessionManager: { getSessionId: () => owner },
						hasUI: false,
					} as ExtensionContext),
				);
				return { ...result, isError: "isError" in result && result.isError };
			},
		};
	}
	const childContext = (): ExtensionContext => ({
		...parentContext,
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			executionEnded: new AbortController().signal,
		},
	});
	const parent = endpoint("parent", parentContext);
	parent.receive("parent-question");
	const children = [endpoint("child-a", childContext()), endpoint("child-b", childContext())];
	for (const child of children) {
		assert.deepEqual((await child.call("pending")).content, [{ type: "text", text: "No unresolved inbound asks." }]);
		assert.equal((await child.call("reply")).isError, true);
		assert.equal((await child.call("reply", "parent-question")).isError, true);
	}
	assert.deepEqual(sent, []); // Local refusal, not a claim about broker authorization.
	children[0].receive("child-a-question");
	children[1].receive("child-b-question");
	for (const endpoint of [parent, ...children]) endpoint.rebind();
	for (const [index, child] of children.entries()) {
		const own = `child-${index === 0 ? "a" : "b"}-question`;
		const pending = JSON.stringify((await child.call("pending")).content);
		assert.ok(pending.includes(own));
		assert.ok(!pending.includes("parent-question"));
		assert.equal((await child.call("reply", index === 0 ? "child-b-question" : "child-a-question")).isError, true);
		assert.equal((await child.call("reply")).isError, false);
	}
	const replacement = endpoint("replacement", parentContext);
	assert.ok(JSON.stringify((await replacement.call("pending")).content).includes("parent-question"));
	assert.equal((await replacement.call("reply")).isError, false);
	assert.deepEqual(sent, [
		{ owner: "child-a", replyTo: "child-a-question" },
		{ owner: "child-b", replyTo: "child-b-question" },
		{ owner: "replacement", replyTo: "parent-question" },
	]);
	assert.deepEqual((await parent.call("pending")).content, [{ type: "text", text: "No unresolved inbound asks." }]);
});

// #3105: a child must neither publish a stage ledger nor retain it at cleanup.
test("child-first binding and cleanup leave the stage generation owned by its parent", () => {
	const parent = stageContext(new WorkflowStageAdmissionBoundary());
	const execution = new AbortController();
	const child: ExtensionContext = {
		...parent,
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			executionEnded: execution.signal,
		},
	};
	const childTracker = bindWorkflowReplyTracker(child, new ReplyTracker());
	childTracker.recordIncomingMessage(sender, message);
	const parentTracker = bindWorkflowReplyTracker(parent, new ReplyTracker());
	assert.deepEqual(parentTracker.listPending(), []);
	assert.equal(preserveWorkflowReplyTracker(child), false);
	execution.abort();
	assert.equal(bindWorkflowReplyTracker(child, childTracker), childTracker);
	assert.equal(preserveWorkflowReplyTracker(child), false);
	assert.equal(preserveWorkflowReplyTracker(parent), true);
});
