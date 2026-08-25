import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function sessionInternals(session: Harness["session"]): AgentSessionInternalSurface {
	return session as AgentSessionInternalSurface;
}
function zeroUsageAssistant(harness: Harness): AssistantMessage {
	const model = harness.getModel();
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("#8328 zero-usage auto-compaction", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		vi.restoreAllMocks();
		harness?.cleanup();
	});

	it("uses message-size estimates when all provider usage is zero", async () => {
		harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 20 }],
			settings: { compaction: { enabled: true, reserveTokens: 10 } },
		});
		const assistant = zeroUsageAssistant(harness);
		harness.session.agent.state.messages = [
			{ role: "user", content: "x".repeat(400), timestamp: assistant.timestamp - 1 },
			assistant,
		];
		const internals = sessionInternals(harness.session);
		const run = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue("failed");

		await internals._checkCompaction(assistant);

		expect(run).toHaveBeenCalledWith("threshold", false);
	});
});
