import assert from "node:assert/strict";
import type { ToolDefinition } from "@bastani/atomic";
import { test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { registerContactSupervisorTool } from "../../packages/intercom/contact-supervisor-tool.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";
import {
	replyWaitGates,
	replyWaitMayBeAdmitted,
	replyWaitMayDetach,
} from "../../packages/intercom/released-reply-wait.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const ROUTINGS = ["on", "starting", "unavailable", undefined, "off"] as const;
const releasesWithRouting = (status: (typeof ROUTINGS)[number]): boolean => status === "off" || status === "on";

function predicatesFor(client: IntercomClient): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as never;
	const deps = {
		childOrchestratorMetadata: () => null,
		ensureConnected: async () => client,
		syncPresenceIdentity() {},
		resolveSessionTarget: async () => null,
		beginReplyWait: () => ({ ok: false as const, reason: "cancelled" as const }),
		mayDetachReplyWait: () => replyWaitMayDetach(true, client.multiNodeRouting),
		mayAdmitReplyWait: () => replyWaitMayBeAdmitted(true, client.multiNodeRouting),
	};
	registerIntercomTool(pi, {
		...deps,
		confirmSend: false,
		homeGroup: () => "default",
		setJoinedGroups() {},
		clearJoinedGroups() {},
		replyTracker: () => {
			throw new Error("not used");
		},
	});
	registerContactSupervisorTool(pi, deps);
	return tools;
}

test("an ask or supervisor request is released with local or multi-node routing, and stays live while routing is unsettled (#4386)", () => {
	for (const status of ROUTINGS) {
		const client = new IntercomClient();
		const internal = client as unknown as { handleBrokerMessage(message: object): void };
		internal.handleBrokerMessage({
			type: "registered",
			sessionId: "child",
			...(status === undefined ? {} : { multiNodeRouting: status }),
		});
		const tools = predicatesFor(client);
		const ask = tools.get("intercom")?.detachable;
		const supervisor = tools.get("contact_supervisor")?.detachable;
		assert.equal(typeof ask, "function");
		assert.equal(typeof supervisor, "function");
		assert.equal(
			typeof ask === "function" && ask({ action: "ask" }),
			releasesWithRouting(status),
			`intercom: ${status}`,
		);
		assert.equal(
			typeof supervisor === "function" && supervisor({ reason: "need_decision" }),
			releasesWithRouting(status),
			`supervisor: ${status}`,
		);
		assert.equal(
			typeof supervisor === "function" && supervisor({ reason: "interview_request" }),
			releasesWithRouting(status),
			`interview: ${status}`,
		);
	}
});

test("a reply wait is admitted before its session connects, but detaches only once routing is confirmed (#4386)", () => {
	for (const status of ROUTINGS) {
		assert.equal(replyWaitMayDetach(true, status), releasesWithRouting(status), `connected: ${status}`);
		assert.equal(replyWaitMayBeAdmitted(true, status), releasesWithRouting(status), `connected admission: ${status}`);
		assert.equal(replyWaitMayDetach(false, status), false, `disconnected: ${status}`);
		assert.equal(replyWaitMayBeAdmitted(false, status), true, `disconnected admission: ${status}`);
	}
});

test("the gates read the session's current connection, and admit a call before there is one (#4386)", () => {
	let connection: { isConnected(): boolean; multiNodeRouting: (typeof ROUTINGS)[number] } | null = null;
	const gates = replyWaitGates(() => connection);
	assert.equal(gates.mayAdmitReplyWait(), true, "no connection yet");
	assert.equal(gates.mayDetachReplyWait(), false, "no connection yet");
	for (const status of ROUTINGS) {
		connection = { isConnected: () => true, multiNodeRouting: status };
		assert.equal(gates.mayAdmitReplyWait(), releasesWithRouting(status), `admit: ${status}`);
		assert.equal(gates.mayDetachReplyWait(), releasesWithRouting(status), `detach: ${status}`);
		connection = { isConnected: () => false, multiNodeRouting: status };
		assert.equal(gates.mayAdmitReplyWait(), true, `admit while reconnecting: ${status}`);
		assert.equal(gates.mayDetachReplyWait(), false, `detach while reconnecting: ${status}`);
	}
});
