import assert from "node:assert/strict";
import type { ToolDefinition } from "@bastani/atomic";
import { test } from "vitest";
import { IntercomClient } from "../../packages/intercom/broker/client.js";
import { registerContactSupervisorTool } from "../../packages/intercom/contact-supervisor-tool.js";
import { registerIntercomTool } from "../../packages/intercom/intercom-tool.js";

function predicatesFor(client: IntercomClient): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as never;
	const deps = {
		childOrchestratorMetadata: () => null,
		ensureConnected: async () => client,
		syncPresenceIdentity() {},
		resolveSessionTarget: async () => null,
		beginReplyWait: () => ({ ok: false as const, reason: "cancelled" as const }),
		mayDetachReplyWait: () => client.multiNodeRouting === "off",
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

test("an ask or supervisor request stays live while its broker routes multi-node (#4326)", () => {
	for (const status of ["on", "starting", "unavailable", undefined, "off"] as const) {
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
		assert.equal(typeof ask === "function" && ask({ action: "ask" }), status === "off", `intercom: ${status}`);
		assert.equal(
			typeof supervisor === "function" && supervisor({ reason: "need_decision" }),
			status === "off",
			`supervisor: ${status}`,
		);
		assert.equal(
			typeof supervisor === "function" && supervisor({ reason: "interview_request" }),
			status === "off",
			`interview: ${status}`,
		);
	}
});
