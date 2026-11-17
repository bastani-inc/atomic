import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { STOP_ALL_STATUS_KEY } from "../../packages/coding-agent/src/modes/interactive/interactive-stop-all.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";

test("the host's Ctrl+X Ctrl+K notice reaches the engine's views as a status, and clears (#5224)", async () => {
	const statuses = new Map<string, string | undefined>();
	const session = Object.create(AgentSession.prototype, {
		extensionRunner: {
			value: {
				getUIContext: () => ({ setStatus: (key: string, text: string | undefined) => statuses.set(key, text) }),
			},
		},
	}) as AgentSession;
	const runtimeHost = Object.create(AgentSessionRuntime.prototype, {
		services: { value: { agentDir: "/fixture" } },
	}) as AgentSessionRuntime;
	const handle = createRpcCommandHandler({
		runtimeHost,
		getSession: () => session,
		rebindSession: async () => {},
		output: () => {},
	});
	const notice = "Press ctrl+x ctrl+k again within 3s to stop all background subagents, shells and workflow runs";
	const shown = await handle({ id: "n", type: "set_stop_all_notice", text: notice });
	assert.equal(shown?.success, true);
	assert.equal(statuses.get(STOP_ALL_STATUS_KEY), notice);
	await handle({ id: "c", type: "set_stop_all_notice" });
	assert.equal(statuses.get(STOP_ALL_STATUS_KEY), undefined, "clearing removes it");
});
