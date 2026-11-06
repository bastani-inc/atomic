import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { registerContactSupervisorTool } from "../../intercom/contact-supervisor-tool.js";
import { registerIntercomTool } from "../../intercom/intercom-tool.js";
import { isReleasedReplyHandoffResult, RELEASED_REPLY_WAIT_ENTRY } from "../../intercom/released-reply-wait.js";
import { routeIncomingReply } from "../../intercom/reply-routing.js";
import { ReplyTracker } from "../../intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../intercom/reply-waiter.js";
import type { SessionInfo } from "../../intercom/types.js";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { harnessPool } from "./helpers/detached-tools.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

for (const name of ["intercom", "contact_supervisor"] as const) {
	test(`${name} stays live until its reply when multi-node routing is active (#4326)`, async () => {
		const registered = new Map<string, ToolDefinition>();
		const waiters = new ReplyWaiterRegistry();
		const sent = Promise.withResolvers<string>();
		const send = async (_to: string, message: { messageId: string }) => {
			sent.resolve(message.messageId);
			return { id: message.messageId, delivered: true };
		};
		const client = {
			sessionId: "child",
			supervisorSessionId: "peer-id",
			groups: ["default"],
			send,
			sendToSupervisor: send,
			listSessions: async () => [],
		};
		const pi = {
			registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
			appendEntry: async () => {},
			events: { emit() {} },
		};
		const common = {
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => "peer-id",
			beginReplyWait: (from: string, id: string, signal?: AbortSignal) => waiters.begin(from, id, signal),
			mayDetachReplyWait: () => false,
		};
		registerIntercomTool(
			pi as never,
			{
				...common,
				confirmSend: false,
				homeGroup: () => "default",
				setJoinedGroups() {},
				clearJoinedGroups() {},
				replyTracker: new ReplyTracker(),
			} as never,
		);
		registerContactSupervisorTool(
			pi as never,
			{
				...common,
				childOrchestratorMetadata: { orchestratorTarget: "peer", runId: "run", agent: "worker", index: 0 },
			} as never,
		);
		const definition = registered.get(name);
		assert.ok(definition);
		const sessionToolName = name === "intercom" ? "peer_ask" : name;
		const harness = await pool.harnessWith([
			{ ...definition, name: sessionToolName, detachmentRequiresReady: false },
		]);
		harness.session.setToolDetachment({ afterMs: 0 });
		const args =
			name === "intercom"
				? { action: "ask", to: "peer", message: "Question?" }
				: { reason: "need_decision", message: "Question?" };
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(sessionToolName, args, { id: "ask-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		let ended = false;
		const run = harness.session.prompt("Ask the peer").then(() => {
			ended = true;
		});
		const questionId = await Promise.race([
			sent.promise,
			run.then(() => {
				throw new Error(
					`The call ended before sending: ${JSON.stringify(harness.sessionManager.getEntries().slice(-3))}`,
				);
			}),
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(ended, false, "the waiting call did not release its session");
		assert.equal(
			routeIncomingReply(waiters.pending(), { id: "peer-id" } as SessionInfo, {
				id: "reply",
				timestamp: 1,
				replyTo: questionId,
				content: { text: "Approved" },
			}),
			true,
		);
		await run;
		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
	});

	test(`${name} records its delivered question before releasing the waiter (#4326)`, async () => {
		const registered = new Map<string, ToolDefinition>();
		const entries: Array<{ type: string; data: object }> = [];
		const waiters = new ReplyWaiterRegistry();
		const sent = Promise.withResolvers<string>();
		const send = async (_to: string, message: { messageId: string }) => {
			sent.resolve(message.messageId);
			return { id: message.messageId, delivered: true };
		};
		const client = {
			sessionId: "child",
			supervisorSessionId: "peer-id",
			groups: ["default"],
			send,
			sendToSupervisor: send,
			listSessions: async () => [],
		};
		const pi = {
			registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
			appendEntry: async (type: string, data: object) => {
				entries.push({ type, data });
			},
			events: { emit() {} },
		};
		const common = {
			ensureConnected: async () => client,
			syncPresenceIdentity() {},
			resolveSessionTarget: async () => "peer-id",
			beginReplyWait: (from: string, id: string, signal?: AbortSignal) => waiters.begin(from, id, signal),
			mayDetachReplyWait: () => true,
		};
		registerIntercomTool(
			pi as never,
			{
				...common,
				confirmSend: false,
				homeGroup: () => "default",
				setJoinedGroups() {},
				clearJoinedGroups() {},
				replyTracker: new ReplyTracker(),
			} as never,
		);
		registerContactSupervisorTool(
			pi as never,
			{
				...common,
				childOrchestratorMetadata: { orchestratorTarget: "peer", runId: "run", agent: "worker", index: 0 },
			} as never,
		);
		const definition = registered.get(name);
		assert.ok(definition);
		const sessionToolName = name === "intercom" ? "peer_ask" : name;
		const harness = await pool.harnessWith([{ ...definition, name: sessionToolName }]);
		harness.session.setToolDetachment({ afterMs: 0 });
		const args =
			name === "intercom"
				? { action: "ask", to: "peer", message: "Question?" }
				: { reason: "need_decision", message: "Question?" };
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(sessionToolName, args, { id: "ask-1" })], { stopReason: "toolUse" }),
		]);
		const run = harness.session.prompt("Ask the peer");
		const questionId = await sent.promise;
		await run;
		const entry = entries.find((item) => item.type === RELEASED_REPLY_WAIT_ENTRY);
		assert.ok(entry);
		assert.deepEqual(
			{ ...entry.data, deadline: 0 },
			{ toolCallId: "ask-1", questionId, from: "peer-id", deadline: 0, retryCount: 0 },
		);
		assert.equal(waiters.releaseRunningWaits(new Error("shutdown")), 1);
		const [call] = harness.session.takeDetachedToolCalls();
		assert.ok(call);
		assert.equal(isReleasedReplyHandoffResult((await call.result).result.details), true);
		assert.equal(waiters.size(), 0);
	});
}
