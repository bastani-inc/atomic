import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { resolveExcludedToolsForAppMode } from "../../../src/main.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("SDK tool exclusions", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-exclude-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		options: {
			tools?: string[];
			excludedTools?: string[];
			noTools?: "all" | "builtin";
			customTools?: Parameters<typeof createAgentSession>[0]["customTools"];
			extensionToolName?: string;
		} = {},
	) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: options.extensionToolName
				? [
						(pi) => {
							pi.on("session_start", () => {
								pi.registerTool({
									name: options.extensionToolName!,
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
					]
				: undefined,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: options.tools,
			excludedTools: options.excludedTools,
			noTools: options.noTools,
			customTools: options.customTools,
		});
		return session;
	}

	it("excludes ask_user_question while retaining other default tools", async () => {
		const session = await createSession({
			excludedTools: ["ask_user_question", "ask_user_question", "not_a_real_tool"],
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("ask_user_question");
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "todo"]),
		);
		expect(session.getActiveToolNames()).not.toContain("ask_user_question");
		expect(session.agent.state.tools.map((tool) => tool.name)).not.toContain("ask_user_question");
		expect(session.systemPrompt).not.toContain("ask_user_question");

		session.dispose();
	});

	it("preserves static ask_user_question guidance for allowlisted sessions when excludedTools is omitted", async () => {
		const session = await createSession({
			tools: ["read"],
		});

		expect(session.getAllTools().map((tool) => tool.name).sort()).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toContain("- read: Read a path selector.");
		expect(session.systemPrompt).not.toContain("- ask_user_question:");
		expect(session.systemPrompt).toContain("using the ask_user_question tool if available");

		session.dispose();
	});

	it("applies the tools allowlist before excludedTools", async () => {
		const session = await createSession({
			tools: ["read", "bash", "ask_user_question"],
			excludedTools: ["ask_user_question"],
		});

		expect(session.getAllTools().map((tool) => tool.name).sort()).toEqual(["bash", "read"]);
		expect(session.getActiveToolNames().sort()).toEqual(["bash", "read"]);
		expect(session.systemPrompt).toContain("- read: Read a path selector.");
		expect(session.systemPrompt).toContain("- bash:");
		expect(session.systemPrompt).not.toContain("ask_user_question");

		session.dispose();
	});

	it("preserves noTools builtin behavior while making excluded names unavailable", async () => {
		const session = await createSession({
			noTools: "builtin",
			excludedTools: ["ask_user_question"],
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("ask_user_question");
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "todo"]),
		);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).toContain("Available tools:\n(none)");
		expect(session.systemPrompt).not.toContain("ask_user_question");

		session.dispose();
	});

	it("excludes SDK custom tools from the available and active tool sets", async () => {
		const session = await createSession({
			excludedTools: ["sdk_tool"],
			customTools: [
				{
					name: "sdk_tool",
					label: "SDK Tool",
					description: "Tool registered through createAgentSession",
					promptSnippet: "Run SDK tool behavior",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				},
			],
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("sdk_tool");
		expect(session.getActiveToolNames()).not.toContain("sdk_tool");
		expect(session.systemPrompt).not.toContain("sdk_tool");

		session.dispose();
	});

	it("excludes workflow from a real workflow-stage-style tool registry", async () => {
		const session = await createSession({
			extensionToolName: "workflow",
			excludedTools: ["workflow"],
		});

		await session.bindExtensions({});

		expect(session.getActiveToolNames()).not.toContain("workflow");
		expect(session.getToolDefinition("workflow")).toBeUndefined();

		session.dispose();
	});

	it("keeps dynamically registered extension tools excluded after extensions bind", async () => {
		const session = await createSession({
			extensionToolName: "dynamic_tool",
			excludedTools: ["dynamic_tool"],
		});

		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("dynamic_tool");
		expect(session.getActiveToolNames()).not.toContain("dynamic_tool");
		expect(session.systemPrompt).not.toContain("dynamic_tool");

		session.dispose();
	});

	it("main CLI print/json exclusion removes ask_user_question while keeping workflow", async () => {
		const session = await createSession({
			extensionToolName: "workflow",
			excludedTools: resolveExcludedToolsForAppMode("print", undefined),
		});

		await session.bindExtensions({});

		const allToolNames = session.getAllTools().map((tool) => tool.name);
		const activeToolNames = session.getActiveToolNames();

		expect(allToolNames).not.toContain("ask_user_question");
		expect(activeToolNames).not.toContain("ask_user_question");
		expect(activeToolNames).toContain("workflow");
		expect(session.getToolDefinition("workflow")).toBeDefined();
		expect(session.systemPrompt).not.toContain("ask_user_question");

		session.dispose();
	});

	it("main CLI app-mode exclusion adds ask_user_question only for print/json", () => {
		expect(resolveExcludedToolsForAppMode("print", undefined)).toEqual(["ask_user_question"]);
		expect(resolveExcludedToolsForAppMode("json", ["custom_tool"])).toEqual([
			"custom_tool",
			"ask_user_question",
		]);
		expect(resolveExcludedToolsForAppMode("rpc", ["workflow"])).toEqual(["workflow"]);
		expect(resolveExcludedToolsForAppMode("interactive", ["workflow"])).toEqual(["workflow"]);
		expect(resolveExcludedToolsForAppMode("interactive", undefined)).toBeUndefined();
	});

	it("forwards excludedTools through service-based session creation", async () => {
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
			excludedTools: ["ask_user_question"],
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("ask_user_question");
		expect(session.getActiveToolNames()).not.toContain("ask_user_question");
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "todo"]));
		expect(session.systemPrompt).not.toContain("ask_user_question");

		session.dispose();
	});
});
