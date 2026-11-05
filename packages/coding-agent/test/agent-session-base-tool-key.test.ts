import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, expect, test } from "vitest";
import { createHarness, type Harness } from "./test-harness.ts";

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

	expect(calls).toEqual(["call-1"]);
	expect(harness.session.getLastAssistantText()).toBe("done");
});
