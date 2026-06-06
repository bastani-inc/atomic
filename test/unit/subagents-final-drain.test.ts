import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	assistantStopReason,
	isAssistantFailureStopReason,
	shouldStartSubagentFinalDrain,
} from "../../packages/subagents/src/runs/shared/final-drain.js";

describe("subagent final-drain predicate", () => {
	test("records failure stop reasons separately from final-drain eligibility", () => {
		for (const stopReason of ["error", "aborted"] as const) {
			const message = {
				role: "assistant",
				stopReason,
				content: [{ type: "text", text: "provider attempt failed" }],
			};

			assert.equal(assistantStopReason(message), stopReason);
			assert.equal(isAssistantFailureStopReason(stopReason), true);
			assert.equal(shouldStartSubagentFinalDrain(message), false);
		}
	});

	test("starts final-drain only for a clean assistant stop without tool calls", () => {
		assert.equal(shouldStartSubagentFinalDrain({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
		}), true);

		assert.equal(shouldStartSubagentFinalDrain({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "toolCall", name: "read" }],
		}), false);

		assert.equal(shouldStartSubagentFinalDrain({
			role: "assistant",
			stopReason: "stop",
			errorMessage: "provider transport failed",
			content: [{ type: "text", text: "failed" }],
		}), false);
	});
});
