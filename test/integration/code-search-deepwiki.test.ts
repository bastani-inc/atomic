import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { ExtensionAPI, ToolDefinition } from "@bastani/atomic";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TObject } from "typebox";
import { Value } from "typebox/value";
import { test, vi } from "vitest";
import { z } from "zod";

function captureTools() {
	const tools = new Map<string, ToolDefinition>();
	const atomic = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on: () => () => {},
		registerShortcut: () => {},
		registerCommand: () => {},
	} as Pick<ExtensionAPI, "registerTool" | "on" | "registerShortcut" | "registerCommand"> as ExtensionAPI;
	return { tools, pi: atomic };
}

test("lazy and heavy code_search schemas agree and the registered tool completes an SDK HTTP session", async () => {
	// These raw extension entrypoints are intentionally outside the root typecheck.
	const { default: webAccess } = (await import(
		new URL("../../packages/web-access/index.ts", import.meta.url).href
	)) as {
		default: (atomic: ExtensionAPI) => void;
	};
	const { registerContentTools } = (await import(
		new URL("../../packages/web-access/content-tools.ts", import.meta.url).href
	)) as {
		registerContentTools: (
			atomic: ExtensionAPI,
			deps: { maxInlineContent: number; stripThumbnails: () => never[]; formatFullResults: () => string },
		) => void;
	};
	const lazy = captureTools();
	webAccess(lazy.pi);
	const heavy = captureTools();
	registerContentTools(heavy.pi, { maxInlineContent: 1000, stripThumbnails: () => [], formatFullResults: () => "" });
	const lazyTool = lazy.tools.get("code_search");
	const heavyTool = heavy.tools.get("code_search");
	assert.ok(lazyTool && heavyTool);
	assert.deepEqual(lazyTool.parameters, heavyTool.parameters);
	assert.equal(lazyTool.description, heavyTool.description);
	assert.equal(lazyTool.promptSnippet, heavyTool.promptSnippet);
	assert.deepEqual((lazyTool.parameters as TObject).required, ["repoName", "query"]);
	for (const parameters of [lazyTool.parameters, heavyTool.parameters]) {
		for (const input of [
			{ query: "question" },
			{ repoName: "owner/repo" },
			{ repoName: ["owner/repo"], query: "question" },
			{ repoName: "owner/repo", query: " " },
			{ repoName: "owner/repo", query: "question", maxTokens: 0 },
			{ repoName: "https://github.com/owner/repo", query: "question" },
		]) {
			assert.equal(Value.Check(parameters, input), false);
		}
		assert.equal(Value.Check(parameters, { repoName: "my_org/Repo.name", query: " question\n" }), true);
	}

	const mcp = new McpServer({ name: "deepwiki-fixture", version: "1" });
	mcp.registerTool("ask_question", { inputSchema: { repoName: z.string(), question: z.string() } }, async (args) => {
		assert.deepEqual(args, { repoName: "Owner/Repo", question: " Explain the entry point.\n" });
		return { content: [{ type: "text", text: "SDK session answer" }] };
	});
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
	await mcp.connect(transport);
	const server = createServer((request, response) => {
		void transport.handleRequest(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const nativeFetch = globalThis.fetch;
	const requests: string[] = [];
	vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
		assert.equal(String(url), "https://mcp.deepwiki.com/mcp");
		requests.push(init?.method ?? "GET");
		return nativeFetch(`http://127.0.0.1:${address.port}/mcp`, init);
	});
	try {
		const result = await heavyTool.execute(
			"registered",
			{ repoName: "Owner/Repo", query: " Explain the entry point.\n" },
			new AbortController().signal,
			undefined,
			{} as Parameters<ToolDefinition["execute"]>[4],
		);
		assert.deepEqual(result.content, [{ type: "text", text: "SDK session answer" }]);
		assert.equal(requests.filter((method) => method === "POST").length, 3);
		assert.ok(transport.sessionId);
	} finally {
		vi.unstubAllGlobals();
		await mcp.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
