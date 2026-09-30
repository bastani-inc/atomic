import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

test("tool exposure preserves activation and prevents hidden tools from being activated", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-exposure-"));
	const settingsManager = SettingsManager.inMemory();
	const tools = ["direct", "model-only", "codemode", "deferred", "hidden"].map((exposure) => ({
		name: `tool_${exposure}`,
		label: exposure,
		description: exposure,
		exposure,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
	})) as ToolDefinition[];
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		extensionFactories: [
			(pi) => {
				for (const tool of tools) pi.registerTool(tool);
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader,
		settingsManager,
		// Exercise inline extension exposure without loading unrelated shipped packages.
		builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
		model: getModel("openai-codex", "gpt-6-sol"),
		sessionManager: SessionManager.inMemory(),
	});
	try {
		const active = session.getActiveToolNames();
		assert(active.includes("tool_direct"));
		assert(active.includes("tool_model-only"));
		assert(!active.includes("tool_codemode"));
		assert(!active.includes("tool_deferred"));
		assert(!active.includes("tool_hidden"));
		session.setActiveToolsByName(tools.map((tool) => tool.name));
		assert(!session.getActiveToolNames().includes("tool_hidden"));
	} finally {
		await session.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
