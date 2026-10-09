import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { getDefaultToolNames } from "../../../src/core/tools/index.ts";

describe("noTools builtin mode keeps extension tools enabled", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-no-builtin-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options?: { noTools?: "all" | "builtin"; tools?: string[] }) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			// #3105: isolate coding defaults from optional shipped extension tools.
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			noTools: options?.noTools,
			tools: options?.tools,
		});
		await session.bindExtensions({});
		return session;
	}

	it("keeps extension tools active when built-in defaults are disabled", async () => {
		const session = await createSession({ noTools: "builtin" });

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(
			[
				"ask_user_question",
				"bash",
				"codemode",
				"dynamic_tool",
				"edit",
				"find",
				"intercom",
				"kill",
				"ls",
				...(getDefaultToolNames().includes("powershell") ? (["powershell"] as const) : []),
				"read",
				"search",
				"todo",
				"tool_search",
				"write",
			].sort(),
		);
		expect(session.getActiveToolNames()).toEqual(["intercom", "dynamic_tool"]);
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).toContain("- intercom:");
		expect(session.systemPrompt).not.toContain("- read:");
		expect(session.systemPrompt).not.toContain("- bash:");
		await session.dispose();
	});

	it("exposes no tools when noTools is all", async () => {
		const session = await createSession({ noTools: "all" });

		expect(session.getAllTools().map((tool) => tool.name)).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).not.toContain("- intercom:");
		await session.dispose();
	});

	it("propagates noTools through service-based session creation", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			noTools: "builtin",
		});

		// #3105: service composition includes all five shipped packages.
		expect(session.getActiveToolNames().sort()).toEqual([
			"code_search",
			"fetch_content",
			"get_search_content",
			"intercom",
			"subagent",
			"web_search",
			"workflow",
		]);
		// Native MCP contributes a manager command; tools appear only for configured servers.
		expect(session.extensionRunner?.getCommand("mcp")).toBeDefined();
		expect(session.getToolDefinition("mcp")).toBeUndefined();
		expect(session.systemPrompt).toContain("- intercom:");
		expect(session.systemPrompt).not.toContain("- read:");
		await session.dispose();
	});
});
