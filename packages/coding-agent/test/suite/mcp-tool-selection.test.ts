import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

const mcpTools = ["mcp__docs__search", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

describe("MCP-aware tool selection", () => {
	it.each([
		{ allowedToolNames: ["read", "codemode"], expected: mcpTools },
		{ allowedToolNames: ["read", "codemode", "mcp__docs__*"], expected: ["mcp__docs__search"] },
		{ allowedToolNames: ["read", "codemode"], excludedToolNames: ["*mcp*"], expected: [] },
		{ allowedToolNames: [], expected: [] },
	])(
		"keeps codemode MCP resources without direct declarations: $allowedToolNames",
		async ({ expected, ...selection }) => {
			const harness = await createHarness({
				...selection,
				initialActiveToolNames: selection.allowedToolNames,
				extensionFactories: [
					(pi) => {
						for (const name of [...mcpTools, "codemode"])
							pi.registerTool({
								name,
								label: name,
								description: name,
								parameters: Type.Object({}),
								exposure: name === "codemode" ? "direct" : "codemode",
								execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
							});
					},
				],
			});
			try {
				await harness.session.bindExtensions({});
				expect(harness.session.getCallableToolNames().filter((name) => mcpTools.includes(name))).toEqual(expected);
				expect(harness.session.getActiveToolNames().filter((name) => mcpTools.includes(name))).toEqual([]);
			} finally {
				await harness.cleanup();
			}
		},
	);
});
