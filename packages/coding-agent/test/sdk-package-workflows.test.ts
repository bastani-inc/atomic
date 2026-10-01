import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getModel } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { withMandatoryResourceLoader } from "../src/core/mandatory-resource-loader.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import type { ResourceLoader } from "../src/core/resource-loader-types.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const REAL_SDK_WORKFLOW_RELOAD_TIMEOUT_MS = 120_000;

async function workflowText(session: AgentSession, action: "list" | "reload"): Promise<string> {
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow");
	assert.ok(tool, "SDK session must expose the workflow tool");
	const result = await tool.execute(`workflow-${action}`, { action });
	return result.content.map((entry) => (entry.type === "text" ? entry.text : "")).join("\n");
}
async function executePackageWorkflow(session: AgentSession, name: string, resultPath: string): Promise<void> {
	const tool = session.agent.state.tools.find((entry) => entry.name === "workflow");
	assert.ok(tool);
	const started = await tool.execute("workflow-run", { action: "run", workflow: name, inputs: {} });
	const launch = started.details as { runId?: string; error?: string };
	assert.equal(launch.error, undefined, JSON.stringify(started));
	assert.ok(launch.runId, JSON.stringify(started));
	const deadline = Date.now() + 30_000;
	for (;;) {
		const result = await tool.execute("workflow-status", { action: "status", runId: launch.runId });
		const status = result.details as {
			detail?: { status: string; tools?: { name: string; status: string }[] };
			error?: string;
		};
		assert.equal(status.error, undefined, JSON.stringify(result));
		assert.ok(status.detail, JSON.stringify(result));
		if (status.detail.status !== "running" && status.detail.status !== "pending") {
			assert.equal(status.detail.status, "completed", JSON.stringify(result));
			assert.ok(
				status.detail.tools?.some((node) => node.name === "write-fixture-result" && node.status === "completed"),
				JSON.stringify(result),
			);
			break;
		}
		assert.ok(Date.now() < deadline, JSON.stringify(result));
		await delay(25);
	}
	assert.equal(readFileSync(resultPath, "utf8"), "tracked SDK workflow result");
}

function writeWorkflow(path: string, name: string, resultPath?: string): void {
	writeFileSync(
		path,
		`import { workflow } from "@bastani/workflows";
import { writeFile } from "node:fs/promises";
export default workflow({ name: ${JSON.stringify(name)}, description: "SDK package workflow", inputs: {}, outputs: {}, run: async (ctx) => {
await ctx.tool("write-fixture-result", {}, async () => {
${resultPath ? `await writeFile(${JSON.stringify(resultPath)}, "tracked SDK workflow result");` : ""}
return "tracked SDK workflow result";
});
return {};
} });\n`,
	);
}

test(
	"SDK workflow tool discovers, executes and reloads package workflows alongside MCP servers (#3372)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-sdk-package-workflows-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const packageDir = join(root, "package");
		const workflowsDir = join(packageDir, "workflows");
		const resultPath = join(root, "workflow-result.txt");
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
		writeWorkflow(workflowPath, "sdk-package-hello", resultPath);
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "sdk-workflow-package",
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
			assert.ok((await loader.refreshWorkflowResources()).some((resource) => resource.path === workflowPath));
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(cwd),
				model: getModel("anthropic", "claude-sonnet-4-5")!,
			});
			try {
				assert.match(await workflowText(session, "list"), /sdk-package-hello/);
				assert.match(await workflowText(session, "reload"), /workflow\(s\)/);
				assert.match(await workflowText(session, "list"), /sdk-package-hello/);
				await executePackageWorkflow(session, "sdk-package-hello", resultPath);
				await vi.waitFor(() => assert.ok(session.getActiveToolNames().includes("mcp__sdk_package_fixture__echo")), {
					timeout: 10_000,
				});
				const echo = session.agent.state.tools.find((tool) => tool.name === "mcp__sdk_package_fixture__echo");
				assert.ok(echo, "SDK session must expose the native package MCP tool");
				const invoked = await echo.execute("fixture-echo", { text: "before reload" }, new AbortController().signal);
				assert.deepEqual(invoked.content, [{ type: "text", text: "local package MCP result" }]);
				assert.deepEqual(toolCalls, [{ name: "echo", arguments: { text: "before reload" } }]);
				rmSync(resultPath);
				writeWorkflow(join(workflowsDir, "added.ts"), "sdk-package-added", resultPath);
				rmSync(workflowPath);
				await workflowText(session, "reload");
				const refreshed = await workflowText(session, "list");
				assert.match(refreshed, /sdk-package-added/);
				assert.doesNotMatch(refreshed, /sdk-package-hello/);
				await session.reload({ failOnExtensionErrors: true });
				assert.match(await workflowText(session, "list"), /sdk-package-added/);
				await workflowText(session, "reload");
				assert.match(await workflowText(session, "list"), /sdk-package-added/);
				await executePackageWorkflow(session, "sdk-package-added", resultPath);
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
	REAL_SDK_WORKFLOW_RELOAD_TIMEOUT_MS,
);

function customLoader(loader: DefaultResourceLoader): ResourceLoader {
	return {
		getExtensions: () => loader.getExtensions(),
		getSkills: () => loader.getSkills(),
		getPrompts: () => loader.getPrompts(),
		getThemes: () => loader.getThemes(),
		getAgentsFiles: () => loader.getAgentsFiles(),
		getSystemPrompt: () => loader.getSystemPrompt(),
		getSystemPromptSource: () => loader.getSystemPromptSource(),
		getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
		getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
		extendResources: (paths) => loader.extendResources(paths),
		reload: (options) => loader.reload(options),
	};
}

for (const workflowAccess of ["absent", "snapshot", "refresh"] as const) {
	test(
		`SDK workflow tool supports custom loaders with ${workflowAccess} workflow resources (#3372)`,
		async () => {
			const root = mkdtempSync(join(tmpdir(), "atomic-sdk-custom-workflows-"));
			const agentDir = join(root, "agent");
			const workflowPath = join(root, "custom.ts");
			const disabledPath = join(root, "disabled.ts");
			writeWorkflow(workflowPath, "sdk-custom-first");
			writeWorkflow(disabledPath, "sdk-custom-disabled");
			const settingsManager = SettingsManager.inMemory();
			const base = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, builtinPackagePaths: [] });
			try {
				await base.reload();
				const loader = customLoader(base);
				let resources = [
					{ path: workflowPath, enabled: true },
					{ path: disabledPath, enabled: false },
				];
				if (workflowAccess === "snapshot") {
					loader.getWorkflowResources = function () {
						assert.equal(this, loader);
						return resources;
					};
				}
				if (workflowAccess === "refresh") {
					loader.refreshWorkflowResources = async function () {
						assert.equal(this, loader);
						return resources;
					};
				}
				const { session } = await createAgentSession({
					cwd: root,
					agentDir,
					settingsManager,
					resourceLoader: workflowAccess === "refresh" ? await withMandatoryResourceLoader(loader, root) : loader,
					sessionManager: SessionManager.inMemory(root),
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					builtins: {},
				});
				try {
					const initial = await workflowText(session, "list");
					assert.match(initial, /fan-out-and-synthesize/);
					assert.doesNotMatch(initial, /sdk-custom-disabled/);
					if (workflowAccess === "absent") {
						assert.doesNotMatch(initial, /sdk-custom-first/);
					} else {
						assert.match(initial, /sdk-custom-first/);
						const addedPath = join(root, "added.ts");
						writeWorkflow(addedPath, "sdk-custom-next");
						resources = [{ path: addedPath, enabled: true }];
					}
					await workflowText(session, "reload");
					const refreshed = await workflowText(session, "list");
					assert.match(refreshed, /fan-out-and-synthesize/);
					if (workflowAccess !== "absent") {
						assert.match(refreshed, /sdk-custom-next/);
						assert.doesNotMatch(refreshed, /sdk-custom-first/);
					}
				} finally {
					await session.dispose();
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		REAL_SDK_WORKFLOW_RELOAD_TIMEOUT_MS,
	);
}

test(
	"SDK workflow reload does not discover untrusted project packages (#3372)",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-sdk-untrusted-workflows-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
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
		writeWorkflow(join(packageDir, "untrusted.ts"), "sdk-untrusted-workflow");
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
			assert.deepEqual(await loader.refreshWorkflowResources(), []);
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
				assert.doesNotMatch(await workflowText(session, "list"), /sdk-untrusted-workflow/);
				await workflowText(session, "reload");
				assert.doesNotMatch(await workflowText(session, "list"), /sdk-untrusted-workflow/);
				assert.equal(
					session.getAllTools().some((tool) => tool.name.startsWith("mcp__sdk_untrusted_mcp__")),
					false,
				);
				await session.reload({ failOnExtensionErrors: true });
				assert.doesNotMatch(await workflowText(session, "list"), /sdk-untrusted-workflow/);
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
	REAL_SDK_WORKFLOW_RELOAD_TIMEOUT_MS,
);
