import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { createCodemodeToolDefinition } from "../../src/extensions/codemode/tool.ts";
import type { McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { createToolSearchToolDefinition } from "../../src/extensions/tool-search/tool.ts";
import { createHarness } from "../suite/harness.ts";
import { createTestUiContext } from "./native-test-ui.js";

const deferredEntry: McpServerEntry = {
	name: "deferred",
	config: { command: "echo", exposure: "deferred" },
	source: "test",
};
const codemodeEntry: McpServerEntry = {
	name: "scripted",
	config: { command: "echo", exposure: "codemode" },
	source: "test",
};

describe("native MCP discovery reachability", () => {
	it.each([
		{ exposure: "deferred" as const, entry: deferredEntry, expected: "tool_search" },
		{ exposure: "codemode" as const, entry: codemodeEntry, expected: "codemode" },
	])(
		"activates the $exposure discovery tool when builtin schemas cross a module boundary",
		async ({ entry, expected }) => {
			const notifications: string[] = [];
			const harness = await createHarness({
				initialActiveToolNames: [],
				extensionFactories: [
					{
						path: "builtin:codemode",
						factory: (pi) => {
							const definition = createCodemodeToolDefinition();
							pi.registerTool({ ...definition, parameters: structuredClone(definition.parameters) });
						},
					},
					{
						path: "builtin:tool-search",
						factory: (pi) => {
							const definition = createToolSearchToolDefinition({ tools: pi });
							pi.registerTool({ ...definition, parameters: structuredClone(definition.parameters) });
						},
					},
					createMcpExtension({
						loadConfig: () => ({ servers: [entry], errors: [] }),
						credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
						createTransport: () => {
							throw new Error("connection not needed for discovery activation");
						},
					}),
				],
			});
			try {
				await harness.session.bindExtensions({
					uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
				});
				expect(harness.session.getAllTools().map((tool) => tool.sourceInfo.path)).toContain("builtin:codemode");
				expect(harness.session.getAllTools().map((tool) => tool.sourceInfo.path)).toContain("builtin:tool-search");
				await harness.session.prompt("/mcp");
				expect(harness.session.getActiveToolNames()).toContain(expected);
				expect(notifications).not.toContain(
					"MCP tools are only reachable from the codemode or tool_search tool, but neither is active; they cannot be called.",
				);
			} finally {
				await harness.cleanup();
			}
		},
	);

	it("does not treat a same-name extension tool as the built-in discovery tool", async () => {
		const notifications: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => pi.registerTool(createToolSearchToolDefinition({ tools: pi })),
				createMcpExtension({
					loadConfig: () => ({ servers: [deferredEntry], errors: [] }),
					credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
					createTransport: () => {
						throw new Error("connection not needed for discovery activation");
					},
				}),
			],
		});
		try {
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
			});
			await harness.session.prompt("/mcp");
			expect(harness.session.getAllTools().find((tool) => tool.name === "tool_search")?.sourceInfo.path).not.toBe(
				"builtin:tool-search",
			);
			expect(harness.session.getActiveToolNames()).not.toContain("tool_search");
			expect(notifications).toContain(
				"MCP tools are only reachable from the codemode or tool_search tool, but neither is active; they cannot be called.",
			);
		} finally {
			await harness.cleanup();
		}
	});
});
