import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "../../src/extensions/mcp/client/index.ts";
import { createInMemoryTransportPair } from "../../src/extensions/mcp/client/testing/index.ts";
import type { McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createTestUiContext } from "./native-test-ui.ts";

function createFakeServer(initializeDelayMs: number) {
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "docs", version: "1.0.0" },
				};
			case "tools/list":
				return {
					tools: [
						{
							name: "search",
							description: "Search the docs.",
							inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
						},
					],
				};
			case "tools/call": {
				const params = request.params as { arguments?: { query?: string } };
				const hits = [`${params.arguments?.query} guide`, `${params.arguments?.query} faq`];
				return { content: [{ type: "text", text: hits.join("\n") }] };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const send = () => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		if (request.method !== "initialize" || initializeDelayMs === 0) queueMicrotask(send);
		else setTimeout(send, initializeDelayMs);
	});
	return pair;
}

describe("AgentSession MCP tools after resume and reload", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function setup(
		sessionManager?: SessionManager,
		extensionFactories: ExtensionFactory[] = [],
		initializeDelayMs = 0,
	) {
		const connected: string[] = [];
		const servers: McpServerEntry[] = [
			{ name: "docs", config: { url: "http://unused.invalid", exposure: "deferred" }, source: "test" },
		];
		const factories = [
			...extensionFactories,
			{ factory: createToolSearchExtension(), path: "builtin:tool-search" },
			createMcpExtension({
				loadConfig: () => ({ servers, errors: [] }),
				createTransport: (entry) => {
					connected.push(entry.name);
					const pair = createFakeServer(initializeDelayMs);
					void pair.server.start();
					return pair.client;
				},
			}),
		];
		let extensions = await createTestExtensionsResult(factories);
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await createTestExtensionsResult(factories);
			},
		};
		const harness = await createHarness({ resourceLoader, sessionManager });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected };
	}

	async function loadDocsSearch(harness: Harness) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("loaded"),
		]);
		await harness.session.prompt("load");
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
	}

	it("declares tools tool_search loaded again on resume once their server connects", async () => {
		const first = await setup();
		await loadDocsSearch(first.harness);

		const second = await setup(first.harness.sessionManager);
		await vi.waitFor(() => expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "again" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await second.harness.session.prompt("use it");

		const result = second.harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "mcp__docs__search",
		);
		expect(getMessageText(result)).toBe("again guide\nagain faq");
		const removals = second.harness.session.messages.filter(
			(message) => message.role === "system" && (message.toolsRemoved ?? []).length > 0,
		);
		expect(removals).toEqual([]);
	});

	it.each([
		["drops", ["read"], false],
		["keeps", undefined, true],
	] as const)(
		"%s restored tools when an extension sets the loadout before they register",
		async (_, loadout, kept) => {
			const first = await setup();
			await loadDocsSearch(first.harness);

			const setLoadout: ExtensionFactory = (pi) => {
				pi.on("session_start", () => pi.setActiveTools(loadout ? [...loadout] : [...pi.getActiveTools(), "read"]));
			};
			const second = await setup(first.harness.sessionManager, [setLoadout]);
			await vi.waitFor(() =>
				expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
			);

			expect(second.harness.session.getActiveToolNames().includes("mcp__docs__search")).toBe(kept);
		},
	);

	it("does not activate restored tools that register after the next prompt starts", async () => {
		const first = await setup();
		await loadDocsSearch(first.harness);

		const second = await setup(first.harness.sessionManager, [], 200);
		second.harness.setResponses([fauxAssistantMessage("done")]);
		await second.harness.session.prompt("go");
		await vi.waitFor(() =>
			expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);

		expect(second.harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
	});

	it("declares tools tool_search loaded again after /reload", async () => {
		const { harness, connected } = await setup();
		await loadDocsSearch(harness);

		await harness.session.reload();

		await vi.waitFor(() => expect(connected).toEqual(["docs", "docs"]));
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
	});
});
