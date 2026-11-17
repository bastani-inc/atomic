import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai";
import { afterEach, describe, test } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";
import type { RpcCommand, RpcResponse } from "../src/modes/rpc/rpc-types.js";
import { createHarness, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function handlerFor(): Promise<{ harness: Harness; handle: (command: object) => Promise<RpcResponse> }> {
	const harness = await createHarness({ settings: { retry: { enabled: false } } });
	harnesses.push(harness);
	const handleCommand = createRpcCommandHandler({
		runtimeHost: { session: harness.session, services: { agentDir: harness.tempDir } } as AgentSessionRuntime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		output: () => {},
		keybindings: KeybindingsManager.create(harness.tempDir),
		taskInspectorUi: { custom: async () => undefined as never },
	});
	return {
		harness,
		handle: async (command) => {
			const response = await handleCommand(command as RpcCommand);
			assert.ok(response);
			return response;
		},
	};
}

describe("RPC compaction commands", () => {
	test("compact carries instructions into the boundary message", async () => {
		const { harness, handle } = await handlerFor();
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("task");
		const response = await handle({ id: "1", type: "compact", instructions: "keep the API decisions" });
		assert.equal(response.success, true);
		const result = (response as { data: VerbatimCompactionResult }).data;
		assert.equal(result.form, "cleared");
		assert.ok(result.compactedText.includes("Compaction instructions from the user:\nkeep the API decisions"));
	});

	test("removed background compaction commands still succeed and change nothing", async () => {
		const { handle } = await handlerFor();
		for (const command of [
			{ id: "a", type: "set_background_compaction", enabled: false },
			{ id: "b", type: "set_background_compaction_threshold", percent: 60 },
		]) {
			const response = await handle(command);
			assert.deepEqual(response, { id: command.id, type: "response", command: command.type, success: true });
		}
		const state = await handle({ id: "c", type: "get_state" });
		assert.equal(state.success, true);
		const data = (state as { data: Record<string, string | number | boolean | object> }).data;
		for (const removed of ["compaction", "backgroundCompactionEnabled", "backgroundCompactionThresholdPercent"]) {
			assert.equal(removed in data, false, `get_state still reports ${removed}`);
		}
	});
});
