import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { createHarness, type Harness } from "./test-harness.js";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

test("a base tool override supplied under a key other than its tool's name still registers and runs (#4309)", async () => {
	const calls: string[] = [];
	const shell: AgentTool = {
		name: "bash",
		label: "Bash",
		description: "Records its call",
		parameters: Type.Object({}),
		execute: async (toolCallId) => {
			calls.push(toolCallId);
			return { content: [{ type: "text", text: "ran" }], details: {} };
		},
	};
	const harness = await createHarness({
		responses: [{ toolCalls: [{ id: "call-1", name: "bash", args: {} }] }, "done"],
		baseToolsOverride: { shell },
	});
	harnesses.push(harness);
	harness.session.setActiveToolsByName(["bash"]);

	await harness.session.prompt("run it");

	assert.deepEqual(calls, ["call-1"]);
	assert.equal(harness.session.getLastAssistantText(), "done");
});
