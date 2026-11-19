import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/atomic-ai/compat";
import { test, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.js";

const REAL_SDK_MCP_RELOAD_TIMEOUT_MS = 120_000;

test(
	"SDK calls package MCP tools before and after reload even with legacy workflow manifest entries (#3372)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-sdk-package-mcp-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		linkSharedTranspileCache(agentDir);
		const packageDir = join(root, "package");
		const workflowsDir = join(packageDir, "workflows");
		const toolCalls: Array<{ name: string; arguments: unknown }> = [];
		const server = createServer(async (request, response) => {
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += chunk;
			const message = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: { name: string; arguments: unknown };
			};
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			if (message.method === "tools/call") {
				toolCalls.push({ name: message.params!.name, arguments: message.params!.arguments });
			}
			const result =
				message.method === "initialize"
					? {
							protocolVersion: "2024-11-05",
							capabilities: { tools: {} },
							serverInfo: { name: "sdk-package-fixture", version: "1" },
						}
					: message.method === "tools/call"
						? { content: [{ type: "text", text: "local package MCP result" }] }
						: {
								tools: [
									{
										name: "echo",
										description: "Local fixture echo",
										inputSchema: {
											type: "object",
											properties: { text: { type: "string" } },
											required: ["text"],
										},
									},
								],
							};
			response
				.writeHead(200, { "Content-Type": "application/json" })
				.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		mkdirSync(workflowsDir, { recursive: true });
		const workflowPath = join(workflowsDir, "hello.ts");
		writeFileSync(workflowPath, "throw new Error('Legacy workflow files must not execute.');");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "sdk-mcp-package",
				type: "module",
				pi: {
					workflows: ["./workflows/*.ts"],
					mcpServers: {
						"sdk-package-fixture": { url: `http://127.0.0.1:${address.port}/mcp`, exposure: "direct" },
					},
				},
			}),
		);
		writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ packages: [packageDir] }));
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, builtinPackagePaths: [] });
		try {
			await loader.reload();
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(cwd),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
			});
			try {
				await vi.waitFor(() => assert.ok(session.getActiveToolNames().includes("mcp__sdk_package_fixture__echo")), {
					timeout: 10_000,
				});
				const echo = session.agent.state.tools.find((tool) => tool.name === "mcp__sdk_package_fixture__echo");
				assert.ok(echo, "SDK session must expose the native package MCP tool");
				const invoked = await echo.execute("fixture-echo", { text: "before reload" }, new AbortController().signal);
				assert.deepEqual(invoked.content, [{ type: "text", text: "local package MCP result" }]);
				assert.deepEqual(toolCalls, [{ name: "echo", arguments: { text: "before reload" } }]);
				await session.reload({ failOnExtensionErrors: true });
				await vi.waitFor(() => assert.ok(session.getActiveToolNames().includes("mcp__sdk_package_fixture__echo")), {
					timeout: 10_000,
				});
				const reloadedEcho = session.agent.state.tools.find(
					(tool) => tool.name === "mcp__sdk_package_fixture__echo",
				);
				assert.ok(reloadedEcho, "reload must rediscover the native package MCP tool");
				const reloadedInvocation = await reloadedEcho.execute(
					"reloaded-echo",
					{ text: "after reload" },
					new AbortController().signal,
				);
				assert.deepEqual(reloadedInvocation.content, [{ type: "text", text: "local package MCP result" }]);
				assert.deepEqual(toolCalls, [
					{ name: "echo", arguments: { text: "before reload" } },
					{ name: "echo", arguments: { text: "after reload" } },
				]);
			} finally {
				await session.dispose();
			}
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_SDK_MCP_RELOAD_TIMEOUT_MS,
);

test(
	"SDK reload does not connect to MCP servers from untrusted project packages (#3372)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-sdk-untrusted-mcp-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		linkSharedTranspileCache(agentDir);
		const packageDir = join(root, "package");
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.writeHead(500).end("Untrusted MCP server must not be contacted");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		mkdirSync(packageDir);
		writeFileSync(join(packageDir, "untrusted.ts"), "throw new Error('Untrusted package must not load.');");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "untrusted",
				pi: {
					workflows: ["./untrusted.ts"],
					mcpServers: { "sdk-untrusted-mcp": { url: `http://127.0.0.1:${address.port}/mcp`, exposure: "direct" } },
				},
			}),
		);
		writeFileSync(join(cwd, ".atomic", "settings.json"), JSON.stringify({ packages: [packageDir] }));
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, builtinPackagePaths: [] });
		try {
			await loader.reload();
			assert.deepEqual(loader.getMcpServerContributions(), []);
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(cwd),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
			});
			try {
				assert.equal(
					session.getAllTools().some((tool) => tool.name.startsWith("mcp__sdk_untrusted_mcp__")),
					false,
				);
				await session.reload({ failOnExtensionErrors: true });
				assert.deepEqual(loader.getMcpServerContributions(), []);
				assert.equal(
					session.getAllTools().some((tool) => tool.name.startsWith("mcp__sdk_untrusted_mcp__")),
					false,
				);
			} finally {
				await session.dispose();
			}
			assert.equal(requests, 0, "untrusted MCP contributions must never connect, including after reload");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			rmSync(root, { recursive: true, force: true });
		}
	},
	REAL_SDK_MCP_RELOAD_TIMEOUT_MS,
);
