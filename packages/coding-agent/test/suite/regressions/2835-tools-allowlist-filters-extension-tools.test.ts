import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getModel } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { isSyntheticPath } from "../../../src/core/source-info.ts";
import { linkSharedTranspileCache } from "../../helpers/shared-transpile-cache.ts";

const ONLY_INTERCOM = { subagents: false, mcp: false, "web-access": false } as const;

describe("regression #2835: tool allowlists filter extension tools", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tools-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		linkSharedTranspileCache(agentDir);
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(allowedToolNames?: string[]) {
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

		const { session, extensionsResult } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: allowedToolNames,
			builtins: ONLY_INTERCOM,
		});
		expect(
			extensionsResult.extensions
				.map((extension) => extension.path)
				.filter((path) => !isSyntheticPath(path))
				.map((path) => basename(dirname(path))),
		).toEqual(["intercom"]);
		await session.bindExtensions({});
		return session;
	}

	// #3105: shipped Intercom follows the same allowlist as other tools.
	it("allows only explicitly listed tools", async () => {
		const session = await createSession(["read", "dynamic_tool"]);

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["dynamic_tool", "read"]);
		expect(session.getActiveToolNames().sort()).toEqual(["dynamic_tool", "read"]);
		expect(session.systemPrompt).toContain("- read: Read a path selector.");
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).not.toContain("- intercom:");
		expect(session.systemPrompt).not.toContain("- bash:");
		expect(session.systemPrompt).not.toContain("- edit:");
		await session.dispose();
	});

	it("exposes no tools when the allowlist is empty", async () => {
		const session = await createSession([]);

		expect(session.getAllTools().map((tool) => tool.name)).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).not.toContain("- intercom:");
		expect(session.systemPrompt).not.toContain("dynamic_tool");
		await session.dispose();
	});
});
