import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFixtureModel } from "../../../../../test/helpers/catalog-model-fixtures.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { resolveExcludedToolsForAppMode } from "../../../src/main.ts";
import { linkSharedTranspileCache } from "../../helpers/shared-transpile-cache.ts";

describe("SDK tool exclusions", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-exclude-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		linkSharedTranspileCache(agentDir);
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
						(atomic) => {
							const registerTool = () => {
								atomic.registerTool({
									name: options.extensionToolName!,
									label: "Dynamic Tool",
									description: "Tool registered by an extension",
									promptSnippet: "Run dynamic test behavior",
									parameters: Type.Object({}),
									execute: async () => ({
										content: [{ type: "text", text: "ok" }],
										details: {},
									}),
								});
							};
							if (options.extensionToolName === "intercom") registerTool();
							else atomic.on("session_start", registerTool);
						},
					]
				: undefined,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			// #3105: this fixture isolates coding-tool exclusions and Intercom.
			builtins: { subagents: false, mcp: false, "web-access": false },
			model: getFixtureModel("anthropic", "claude-sonnet-4-5")!,
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
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "todo"]));
		expect(session.getActiveToolNames()).not.toContain("ask_user_question");
		expect(session.agent.state.tools.map((tool) => tool.name)).not.toContain("ask_user_question");
		expect(session.systemPrompt).not.toContain("ask_user_question");

		await session.dispose();
	});

	it("preserves question-tool fallback guidance for allowlisted sessions when excludedTools is omitted", async () => {
		const session = await createSession({
			tools: ["read"],
		});

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toContain("- read: Read a path selector.");
		expect(session.systemPrompt).not.toContain("- ask_user_question:");
		expect(session.systemPrompt).toContain(
			"If an equivalent user-question tool is available, use it for all questions",
		);
		expect(session.systemPrompt).toContain("including confirmations and approvals, following its supported schema");
		expect(session.systemPrompt).toContain("When no usable question tool or human-input channel exists");
		expect(session.systemPrompt).toContain("continue fully autonomously on best judgment");
		expect(session.systemPrompt).toContain("Preserve safety and authorization constraints");

		await session.dispose();
	});

	it("applies the tools allowlist before excludedTools", async () => {
		const session = await createSession({
			tools: ["read", "bash", "ask_user_question"],
			excludedTools: ["ask_user_question"],
		});

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "read"]);
		expect(session.getActiveToolNames().sort()).toEqual(["bash", "read"]);
		expect(session.systemPrompt).toContain("- read: Read a path selector.");
		expect(session.systemPrompt).toContain("- bash:");
		expect(session.systemPrompt).not.toContain("ask_user_question");

		await session.dispose();
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
		expect(session.getActiveToolNames()).toEqual(["intercom"]);
		expect(session.systemPrompt).toContain("- intercom:");
		expect(session.systemPrompt).not.toContain("ask_user_question");

		await session.dispose();
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

		await session.dispose();
	});

	it("excludes a named tool from the session registry", async () => {
		const session = await createSession({
			extensionToolName: "fixture_tool",
			excludedTools: ["fixture_tool"],
		});

		await session.bindExtensions({});

		expect(session.getActiveToolNames()).not.toContain("fixture_tool");
		expect(session.getToolDefinition("fixture_tool")).toBeUndefined();

		await session.dispose();
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

		await session.dispose();
	});

	it("reserves ordinary bundled Intercom against an SDK custom-tool collision", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getFixtureModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.create(tempDir, agentDir),
			sessionManager: SessionManager.inMemory(tempDir),
			tools: ["read", "intercom"],
			excludedTools: ["bash"],
			customTools: [
				{
					name: "intercom",
					label: "Spoofed Intercom",
					description: "SDK collision that must not replace bundled Intercom",
					promptSnippet: "Spoofed Intercom metadata",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "spoofed" }], details: {} }),
				},
			],
		});
		try {
			const info = session.getAllTools().find((tool) => tool.name === "intercom");
			expect(info?.sourceInfo.configurationOrigin).toBe("bundled");
			expect(session.getToolDefinition("intercom")?.label).toBe("Intercom");
			expect(session.getToolDefinition("intercom")?.promptSnippet).not.toBe("Spoofed Intercom metadata");
			expect(session.getActiveToolNames()).toEqual(["read", "intercom"]);
			expect(session.getToolDefinition("bash")).toBeUndefined();
			expect(session.getToolDefinition("contact_supervisor")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("keeps Intercom excluded across SDK restrictions, mutation, and reload", async () => {
		const session = await createSession({
			extensionToolName: "intercom",
			tools: ["read"],
			excludedTools: ["intercom", "bash"],
		});

		await session.bindExtensions({});

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).not.toContain("contact_supervisor");

		session.setActiveToolsByName([]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.getToolDefinition("intercom")).toBeUndefined();
		expect(session.systemPrompt).not.toContain("contact_supervisor");

		await session.reload();
		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["read"]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getToolDefinition("intercom")).toBeUndefined();
		expect(session.getToolDefinition("bash")).toBeUndefined();

		await session.dispose();
	});

	it("exposes no tools when SDK noTools disables all tools", async () => {
		const session = await createSession({ extensionToolName: "intercom", noTools: "all" });

		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);

		await session.dispose();
	});

	it("main CLI print/json exclusion removes ask_user_question while keeping another extension tool", async () => {
		const session = await createSession({
			extensionToolName: "fixture_tool",
			excludedTools: resolveExcludedToolsForAppMode("print", undefined),
		});

		await session.bindExtensions({});

		const allToolNames = session.getAllTools().map((tool) => tool.name);
		const activeToolNames = session.getActiveToolNames();

		expect(allToolNames).not.toContain("ask_user_question");
		expect(activeToolNames).not.toContain("ask_user_question");
		expect(activeToolNames).toContain("fixture_tool");
		expect(session.getToolDefinition("fixture_tool")).toBeDefined();
		expect(session.systemPrompt).not.toContain("ask_user_question");

		await session.dispose();
	});

	it("main CLI app-mode exclusion adds ask_user_question only for print/json", () => {
		expect(resolveExcludedToolsForAppMode("print", undefined)).toEqual(["ask_user_question"]);
		expect(resolveExcludedToolsForAppMode("json", ["custom_tool"])).toEqual(["custom_tool", "ask_user_question"]);
		expect(resolveExcludedToolsForAppMode("rpc", ["fixture_tool"])).toEqual(["fixture_tool"]);
		expect(resolveExcludedToolsForAppMode("interactive", ["fixture_tool"])).toEqual(["fixture_tool"]);
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
			model: getFixtureModel("anthropic", "claude-sonnet-4-5")!,
			excludedTools: ["ask_user_question"],
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("ask_user_question");
		expect(session.getActiveToolNames()).not.toContain("ask_user_question");
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "todo"]));

		await session.dispose();
	});
});
