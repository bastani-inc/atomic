import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createCodemodeToolDefinition } from "../../src/extensions/codemode/tool.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { createHarness, type HarnessOptions } from "../suite/harness.ts";
import { createTestUiContext } from "./native-test-ui.js";

const UNREACHABLE_WARNING =
	"MCP tools are only reachable from the codemode or tool_search tool, but neither is active; they cannot be called.";

const mcpExtension = () =>
	createMcpExtension({
		loadConfig: () => ({
			servers: [{ name: "scripted", config: { command: "echo", exposure: "codemode" }, source: "test" }],
			errors: [],
		}),
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		createTransport: () => {
			throw new Error("connection not needed for discovery activation");
		},
	});

// Deferred project trust starts MCP with the pre-trust extension set; builtin:codemode joins with the final set.
const codemodeAfterSessionStart: { path: string; factory: ExtensionFactory } = {
	path: "builtin:codemode",
	factory: (atomic) => {
		atomic.on("session_start", () => {
			atomic.registerTool(createCodemodeToolDefinition());
		});
	},
};

async function startSession(extensionFactories: HarnessOptions["extensionFactories"]) {
	const notifications: string[] = [];
	const harness = await createHarness({ initialActiveToolNames: [], extensionFactories });
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
	});
	return { harness, notifications };
}

describe("native MCP discovery when built-in discovery tools load after MCP starts", () => {
	it("does not warn while codemode has yet to load, and activates it for the first prompt", async () => {
		const { harness, notifications } = await startSession([mcpExtension(), codemodeAfterSessionStart]);
		try {
			expect(harness.session.getAllTools().find((tool) => tool.name === "codemode")?.sourceInfo.path).toBe(
				"builtin:codemode",
			);
			expect(notifications).not.toContain(UNREACHABLE_WARNING);
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			expect(harness.session.getActiveToolNames()).toContain("codemode");
			expect(notifications).not.toContain(UNREACHABLE_WARNING);
		} finally {
			await harness.cleanup();
		}
	});

	it("still warns before the first prompt when no discovery tool ever loads", async () => {
		const { harness, notifications } = await startSession([mcpExtension()]);
		try {
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			expect(notifications.filter((message) => message === UNREACHABLE_WARNING)).toHaveLength(1);
		} finally {
			await harness.cleanup();
		}
	});
});
