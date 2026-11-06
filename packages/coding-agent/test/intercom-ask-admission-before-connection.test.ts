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

const LIVE_OBSERVATION_MS = 150;

async function askBeforeTheConnectionExists(name: "intercom" | "contact_supervisor", routing: "local" | "multi-node") {
	const registered = new Map<string, ToolDefinition>();
	const entries: Array<{ type: string; data: object }> = [];
	const waiters = new ReplyWaiterRegistry();
	const sent = Promise.withResolvers<string>();
	let connected = false;
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
		ensureConnected: async () => {
			connected = true;
			return client;
		},
		syncPresenceIdentity() {},
		resolveSessionTarget: async () => "peer-id",
		beginReplyWait: (from: string, id: string, signal?: AbortSignal) => waiters.begin(from, id, signal),
		mayAdmitReplyWait: () => !connected || routing === "local",
		mayDetachReplyWait: () => connected && routing === "local",
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
		fauxAssistantMessage("Done"),
	]);
	const run = harness.session.prompt("Ask the peer");
	const questionId = await sent.promise;
	const outcome = await Promise.race([
		run.then(() => "released" as const),
		new Promise<"live">((resolve) => setTimeout(() => resolve("live"), LIVE_OBSERVATION_MS)),
	]);
	return { harness, waiters, entries, questionId, outcome, run };
}

for (const name of ["intercom", "contact_supervisor"] as const) {
	test(`${name} asked before its connection exists detaches once the connection confirms local routing (#4326)`, async () => {
		const { harness, waiters, entries, outcome } = await askBeforeTheConnectionExists(name, "local");
		assert.equal(outcome, "released", "the call released its session after connecting");
		assert.equal(entries.filter((entry) => entry.type === RELEASED_REPLY_WAIT_ENTRY).length, 1);
		assert.equal(waiters.releaseRunningWaits(new Error("shutdown")), 1);
		const [call] = harness.session.takeDetachedToolCalls();
		assert.ok(call);
		assert.equal(isReleasedReplyHandoffResult((await call.result).result.details), true);
	});

	test(`${name} asked before its connection exists stays live when the connection routes multi-node (#4326)`, async () => {
		const { harness, waiters, entries, questionId, outcome, run } = await askBeforeTheConnectionExists(
			name,
			"multi-node",
		);
		assert.equal(outcome, "live", "multi-node routing keeps the child's session");
		assert.equal(entries.filter((entry) => entry.type === RELEASED_REPLY_WAIT_ENTRY).length, 0);
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
}
