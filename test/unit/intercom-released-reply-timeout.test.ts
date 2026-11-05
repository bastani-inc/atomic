import assert from "node:assert/strict";
import type { ToolDefinition } from "@bastani/atomic";
import { test, vi } from "vitest";
import { registerContactSupervisorTool } from "../../packages/intercom/contact-supervisor-tool.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import { ReplyTracker } from "../../packages/intercom/reply-tracker.js";
import { ReplyWaiterRegistry } from "../../packages/intercom/reply-waiter.js";
import { ASK_REPLY_TIMEOUT_MS } from "../../packages/intercom/retry-policy.js";
import { releasedReplyTimeout } from "../../packages/subagents/src/runs/foreground/released-child-replies.js";

for (const name of ["intercom", "contact_supervisor"] as const) {
	test(`a released ${name} timeout matches the inline tool result exactly (#4326)`, async () => {
		vi.useFakeTimers();
		try {
			const tools = new Map<string, ToolDefinition>();
			const waits = new ReplyWaiterRegistry();
			const sent = Promise.withResolvers<void>();
			const send = async (_target: string, message: { messageId: string }) => {
				sent.resolve();
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
				registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
				appendEntry: async () => {},
				events: { emit() {} },
			};
			const deps = {
				ensureConnected: async () => client,
				syncPresenceIdentity() {},
				resolveSessionTarget: async () => "peer-id",
				beginReplyWait: (from: string, id: string, signal?: AbortSignal) => waits.begin(from, id, signal),
			};
			registerIntercomTool(
				pi as never,
				{
					...deps,
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
					...deps,
					childOrchestratorMetadata: { orchestratorTarget: "peer", runId: "run", agent: "worker", index: 0 },
				} as never,
			);
			const tool = tools.get(name);
			assert.ok(tool);
			const params =
				name === "intercom"
					? { action: "ask", to: "peer", message: "Question?" }
					: { reason: "need_decision", message: "Question?" };
			const pending = tool.execute("call-1", params, new AbortController().signal, undefined, {
				sessionManager: { getSessionId: () => "child-session" },
			} as never);
			await sent.promise;
			await vi.advanceTimersByTimeAsync(ASK_REPLY_TIMEOUT_MS);
			const inline = await pending;
			const timed = releasedReplyTimeout({
				toolCallId: "call-1",
				toolName: name,
				replyWait: { questionId: "q-1", deadline: Date.now(), from: "peer-id" },
			});
			assert.deepEqual(
				{ content: timed.result.content, details: timed.result.details, isError: timed.isError },
				{ content: inline.content, details: inline.details, isError: inline.isError },
			);
		} finally {
			vi.useRealTimers();
		}
	});
}
