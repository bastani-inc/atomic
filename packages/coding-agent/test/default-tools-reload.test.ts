import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { inheritChildSessionOptions } from "../src/core/child-session-options.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { getDefaultToolNames } from "../src/core/tools/index.js";

let tempDir: string;
let agentDir: string;
let sessions: AgentSession[];
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "atomic-default-tools-reload-"));
	agentDir = join(tempDir, "agent");
	mkdirSync(agentDir);
	sessions = [];
});
afterEach(() => {
	for (const session of sessions) session.dispose();
	rmSync(tempDir, { recursive: true, force: true });
});
const writeSettings = (settings: object) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
async function createFileSession(
	options: Pick<CreateAgentSessionOptions, "tools" | "noTools" | "excludedTools" | "customTools"> = {},
	transactional = true,
	settingsManager = SettingsManager.create(tempDir, agentDir),
) {
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "inactive_tool",
					label: "Inactive",
					description: "Fixture",
					parameters: Type.Object({}),
					defaultActive: false,
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
		],
	});
	if (!transactional) resourceLoader.supportsTransactionalReload = () => false;
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		settingsManager,
		resourceLoader,
		model: getModel("anthropic", "claude-sonnet-4-5"),
		sessionManager: SessionManager.inMemory(tempDir),
		builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
		...options,
	});
	sessions.push(session);
	return session;
}

for (const transactional of [true, false]) {
	test(`reload activates only newly added defaults with transactional=${transactional} (#10245)`, async () => {
		const session = await createFileSession({}, transactional);
		const defaults = [...getDefaultToolNames()];
		assert.deepEqual(session.getActiveToolNames(), defaults);
		session.setActiveToolsByName(defaults.filter((name) => name !== "bash"));
		writeSettings({ defaultTools: ["+inactive_tool", "+ls"] });
		await session.reload();
		const expected = [...defaults.filter((name) => name !== "bash"), "inactive_tool", "ls"].sort();
		assert.deepEqual(session.getActiveToolNames().sort(), expected);
		writeSettings({ defaultTools: ["-read"] });
		await session.reload();
		assert.deepEqual(session.getActiveToolNames().sort(), expected);
	});

	test(`reload activates new defaults for sessions sharing settings with transactional=${transactional}`, async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const first = await createFileSession({}, transactional, settingsManager);
		const second = await createFileSession({}, transactional, settingsManager);
		const defaults = [...getDefaultToolNames()];
		assert.equal(first.settingsManager, second.settingsManager);
		assert.deepEqual(second.getActiveToolNames(), defaults);
		second.setActiveToolsByName(defaults.filter((name) => name !== "bash"));
		writeSettings({ defaultTools: ["+inactive_tool", "+ls"] });
		await first.reload();
		assert.deepEqual(first.getActiveToolNames().sort(), [...defaults, "inactive_tool", "ls"].sort());
		await second.reload();
		assert.deepEqual(
			second.getActiveToolNames().sort(),
			[...defaults.filter((name) => name !== "bash"), "inactive_tool", "ls"].sort(),
		);
	});

	test(`reload preserves CLI tool modifiers with transactional=${transactional}`, async () => {
		writeSettings({ defaultTools: ["read"] });
		const session = await createFileSession({ tools: ["-bash", "+ls"] }, transactional);
		assert.deepEqual(session.getActiveToolNames(), ["read", "ls"]);
		writeSettings({ defaultTools: ["read", "bash", "inactive_tool"] });
		await session.reload();
		assert.deepEqual(session.getActiveToolNames().sort(), ["inactive_tool", "ls", "read"]);
	});
}

test("reload respects explicit tool options and exclusions (#10245)", async () => {
	const allowlisted = await createFileSession({ tools: ["read"] });
	writeSettings({ defaultTools: ["+ls"] });
	await allowlisted.reload();
	assert.deepEqual(allowlisted.getActiveToolNames(), ["read"]);
	writeSettings({});
	const builtinless = await createFileSession({ noTools: "builtin" });
	writeSettings({ defaultTools: ["+ls"] });
	await builtinless.reload();
	assert.deepEqual(builtinless.getActiveToolNames(), []);
	writeSettings({});
	const toolless = await createFileSession({ noTools: "all" });
	writeSettings({ defaultTools: ["+ls", "+inactive_tool"] });
	await toolless.reload();
	assert.deepEqual(toolless.getActiveToolNames(), []);
	writeSettings({});
	const excluded = await createFileSession({ excludedTools: ["ls"] });
	writeSettings({ defaultTools: ["+ls", "+inactive_tool"] });
	await excluded.reload();
	assert.deepEqual(excluded.getActiveToolNames().sort(), [...getDefaultToolNames(), "inactive_tool"].sort());
});

test("SDK tool modifiers retain custom activation and total suppression", async () => {
	writeSettings({ defaultTools: ["read", "write"] });
	const session = await createFileSession({ tools: ["+inactive_tool", "-write"] });
	assert.deepEqual(session.getActiveToolNames().sort(), ["inactive_tool", "read"]);
	const suppressed = await createFileSession({ noTools: "all", tools: ["+inactive_tool", "+read"] });
	assert.deepEqual(suppressed.getAllTools(), []);
	writeSettings({ defaultTools: ["read", "inactive_tool"] });
	await suppressed.reload();
	assert.deepEqual(suppressed.getAllTools(), []);
});

test("child SDK modifiers preserve permitted custom tools and respect removals", async () => {
	writeSettings({ defaultTools: ["read", "bash"] });
	const parentOptions = {
		cwd: tempDir,
		tools: ["read", "bash", "sdk_tool"],
		settingsManager: SettingsManager.create(tempDir, agentDir),
		customTools: [
			{
				name: "sdk_tool",
				label: "SDK tool",
				description: "Fixture",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
			},
		],
	};
	const parent = await createFileSession(parentOptions, true, parentOptions.settingsManager);
	const availableTools = parent.getAllTools().map((tool) => tool.name);
	for (const [tools, expected] of [
		[undefined, ["bash", "read", "sdk_tool"]],
		[["-bash"], ["read", "sdk_tool"]],
		[["-bash", "-sdk_tool", "+write"], ["read"]],
	] as const) {
		const options = inheritChildSessionOptions(
			parentOptions,
			{ tools: tools ? [...tools] : undefined },
			availableTools,
		);
		const child = await createFileSession(options, true, parentOptions.settingsManager);
		assert.deepEqual(child.getActiveToolNames().sort(), expected);
		assert.deepEqual(
			child
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
			expected,
		);
	}
});

test("SDK rejects mixed tool lists and modifier patterns", async () => {
	await assert.rejects(createFileSession({ tools: ["read", "+ls"] }), /tool names cannot be mixed/);
	await assert.rejects(createFileSession({ tools: ["-mcp__docs__*"] }), /take exact tool names, not patterns/);
});
