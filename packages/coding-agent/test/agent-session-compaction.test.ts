import assert from "node:assert/strict";
import { describe, expect, it, test } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { agentSessionCompactionMethods } from "../src/core/agent-session-compaction.js";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";

describe("AgentSession compaction surface", () => {
	it("exposes compact as the only boundary-creating manual door", () => {
		expect(agentSessionCompactionMethods.compact).toBeTypeOf("function");
		expect(["context", "Compact"].join("") in agentSessionCompactionMethods).toBe(false);
		expect(agentSessionCompactionMethods._applyVerbatimCompaction).toBeTypeOf("function");
	});
});

test("RPC get_state round-trips the active compaction reason and start time (#5243)", async () => {
	const session = Object.assign(Object.create(AgentSession.prototype) as AgentSession, {
		agent: {
			state: { model: undefined, thinkingLevel: "off", messages: [] },
			steeringMode: "all",
			followUpMode: "all",
		},
		sessionManager: SessionManager.inMemory(process.cwd()),
		settingsManager: {
			getCompactionEnabled: () => true,
		},
		_resourceLoader: { getExtensions: () => ({ extensions: [], overlaps: [] }) },
		_scopedModels: [],
		_steeringMessages: [],
		_followUpMessages: [],
		_queuedMessagesPaused: false,
		_autoCompactionAbortController: new AbortController(),
		_compactionReason: "threshold",
		_compactionStartedAt: 4_000,
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("unused");
	};
	const runtimeHost = new AgentSessionRuntime(
		session,
		{ cwd: process.cwd(), agentDir: process.cwd() } as never,
		createRuntime,
	);
	const handler = createRpcCommandHandler({
		runtimeHost,
		getSession: () => session,
		rebindSession: async () => {},
		output: () => {},
	});

	const response = await handler({ type: "get_state" });
	assert.ok(response);
	assert.equal(response.success, true);
	if (!response.success || !("data" in response)) throw new Error("get_state did not return state data");
	assert.equal(response.data.isCompacting, true);
	assert.equal(response.data.compactionReason, "threshold");
	assert.equal(response.data.compactionStartedAt, 4_000);
});
