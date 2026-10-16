import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { createAgentSessionFromServices, prepareAgentSessionServices } from "../src/core/agent-session-services.js";
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
	options: Pick<
		CreateAgentSessionOptions,
		| "tools"
		| "noTools"
		| "excludedTools"
		| "customTools"
		| "sessionManager"
		| "orchestrationContext"
		| "subagentPolicy"
	> = {},
	transactional = true,
	settingsManager = SettingsManager.create(tempDir, agentDir),
	deferExtensions = false,
	startupTool?: string,
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
				if (deferExtensions) {
					pi.registerTool({
						name: "active_tool",
						label: "Active",
						description: "Fixture",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
				if (startupTool) pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(), startupTool]));
			},
		],
	});
	await resourceLoader.reload({ deferExtensions });
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
	if (!transactional) session.resourceLoader.supportsTransactionalReload = () => false;
	assert.equal(session.resourceLoader.supportsTransactionalReload?.(), transactional);
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

async function recordedSession(toolNames: string[]) {
	const sessionManager = SessionManager.inMemory(tempDir);
	await sessionManager.appendMessage({
		role: "system",
		content: "",
		toolsAdded: toolNames.map((name) => ({ name, description: name, parameters: Type.Object({}) })),
		timestamp: Date.now(),
	});
	return sessionManager;
}

test("resume restores the recorded built-in and extension loadout (#10785)", async () => {
	const session = await createFileSession({ sessionManager: await recordedSession(["read", "ls", "inactive_tool"]) });
	assert.deepEqual(session.getActiveToolNames().sort(), ["inactive_tool", "ls", "read"]);
});

test("resume applies tool modifiers to the recorded loadout (#10785)", async () => {
	const session = await createFileSession({
		sessionManager: await recordedSession(["read", "ls", "inactive_tool"]),
		tools: ["-ls", "+write"],
	});
	assert.deepEqual(session.getActiveToolNames().sort(), ["inactive_tool", "read", "write"]);
});

test("resume respects exclusions and explicit selections (#10785)", async () => {
	const excluded = await createFileSession({
		sessionManager: await recordedSession(["read", "ls", "inactive_tool"]),
		excludedTools: ["inactive_tool"],
	});
	assert.deepEqual(excluded.getActiveToolNames().sort(), ["ls", "read"]);
	const allowlisted = await createFileSession({
		sessionManager: await recordedSession(["read", "ls", "inactive_tool"]),
		tools: ["read", "write"],
	});
	assert.deepEqual(allowlisted.getActiveToolNames(), ["read", "write"]);
	const builtinless = await createFileSession({
		sessionManager: await recordedSession(["read", "ls", "inactive_tool"]),
		noTools: "builtin",
	});
	assert.deepEqual(builtinless.getActiveToolNames(), ["inactive_tool"]);
	const toolless = await createFileSession({
		sessionManager: await recordedSession(["read", "ls", "inactive_tool"]),
		noTools: "all",
	});
	assert.deepEqual(toolless.getActiveToolNames(), []);
});

test("resume keeps defaults when no loadout was recorded (#10785)", async () => {
	const sessionManager = SessionManager.inMemory(tempDir);
	await sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
	const session = await createFileSession({ sessionManager });
	assert.deepEqual(session.getActiveToolNames(), getDefaultToolNames());
});

for (const childKind of ["workflow", "subagent"] as const) {
	test(`forked ${childKind} keeps injected tools with default tool selection (#3624)`, async () => {
		const toolName = childKind === "workflow" ? "structured_output" : "child_tool";
		const session = await createFileSession({
			sessionManager: await recordedSession(["read", "bash", "edit", "write"]),
			...(childKind === "workflow"
				? {
						orchestrationContext: {
							kind: "workflow-stage" as const,
							workflowRunId: "fork-loadout",
							workflowStageId: "schema",
							workflowStageName: "Schema",
							constraints: { disableWorkflowTool: true as const },
						},
					}
				: { subagentPolicy: { depth: 1, managementActions: "restricted" as const, fanoutAuthorized: false } }),
			customTools: [
				{
					name: toolName,
					label: toolName,
					description: "Fixture",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
				},
			],
		});
		assert.deepEqual(session.getActiveToolNames().sort(), [...getDefaultToolNames(), toolName].sort());
		await session.reload({ reason: "startup" });
		assert.deepEqual(session.getActiveToolNames().sort(), [...getDefaultToolNames(), toolName].sort());
	});
}

for (const transactional of [true, false]) {
	for (const modified of [true, false]) {
		test(`startup restores deferred recorded tools with transactional=${transactional}, modified=${modified} (#3624)`, async () => {
			const session = await createFileSession(
				{
					sessionManager: await recordedSession(["read", "ls", "inactive_tool"]),
					...(modified ? { tools: ["-ls", "+write"], excludedTools: ["inactive_tool"] } : {}),
				},
				transactional,
				SettingsManager.create(tempDir, agentDir),
				true,
			);
			assert.deepEqual(session.getActiveToolNames().sort(), modified ? ["read", "write"] : ["ls", "read"]);
			await session.reload({ reason: "startup" });
			assert.deepEqual(
				session.getActiveToolNames().sort(),
				modified ? ["read", "write"] : ["inactive_tool", "ls", "read"],
			);
			await session.reload();
			assert.ok(session.getActiveToolNames().includes("active_tool"));
		});
	}
}

test("forked child restoration respects modifiers, exclusions, allowlists and parent ceilings (#3624)", async () => {
	const parent = { cwd: tempDir, tools: ["read"] };
	const restrictedOptions: CreateAgentSessionOptions[] = [
		{ tools: ["read"] },
		{ excludedTools: ["child_tool"] },
		{ tools: ["-child_tool"] },
		{ noTools: "all" },
		inheritChildSessionOptions(parent, { tools: ["read", "child_tool"] }, ["read", "child_tool"]),
	];
	for (const options of restrictedOptions) {
		const session = await createFileSession({
			...options,
			sessionManager: await recordedSession(["read", "bash", "child_tool"]),
			subagentPolicy: { depth: 1, managementActions: "restricted", fanoutAuthorized: false },
			customTools: [
				{
					name: "child_tool",
					label: "Child tool",
					description: "Fixture",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
				},
			],
		});
		assert.ok(!session.getActiveToolNames().includes("child_tool"));
		await session.reload({ reason: "startup" });
		assert.ok(!session.getActiveToolNames().includes("child_tool"));
		if (options.tools?.includes("read")) assert.deepEqual(session.getActiveToolNames(), ["read"]);
	}
});

for (const transactional of [true, false]) {
	test(`startup handlers see recorded tools and can activate tools with transactional=${transactional} (#3624)`, async () => {
		const session = await createFileSession(
			{ sessionManager: await recordedSession(["read", "inactive_tool"]) },
			transactional,
			SettingsManager.create(tempDir, agentDir),
			true,
			"find",
		);
		await session.reload({ reason: "startup" });
		assert.deepEqual(session.getActiveToolNames().sort(), ["find", "inactive_tool", "read"]);
	});
}

for (const activate of [false, true]) {
	for (const safeChange of ["none", "activate", "deactivate"] as const) {
		test(`startup completion preserves tool choices, activation=${activate}, safeChange=${safeChange} (#3624)`, async () => {
			const extensionDir = join(tempDir, ".atomic", "extensions");
			mkdirSync(extensionDir, { recursive: true });
			writeFileSync(
				join(extensionDir, "startup.ts"),
				`export default function(pi) {
				for (const name of ["startup_probe", "newcomer_probe"]) {
					pi.registerTool({ name, label: name, description: "Fixture",
						parameters: { type: "object", properties: {} },
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
				}
				pi.on("session_start", () => {
					pi.setSessionName(JSON.stringify(pi.getActiveTools().sort()));
					if (${activate}) pi.setActiveTools([...pi.getActiveTools(), "newcomer_probe"]);
				});
			}`,
			);
			const settingsManager = SettingsManager.create(tempDir, agentDir, { projectTrusted: false });
			let completeTrust!: () => Promise<void>;
			const completeServices = await prepareAgentSessionServices({
				cwd: tempDir,
				agentDir,
				settingsManager,
				resourceLoaderOptions: {
					builtinPackagePaths: [],
					extensionFactories: [
						(pi) => {
							pi.on("session_start", () => {
								if (safeChange === "activate") pi.setActiveTools([...pi.getActiveTools(), "find"]);
								if (safeChange === "deactivate")
									pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "read"));
							});
						},
					],
					noSkills: true,
					noThemes: true,
					noPromptTemplates: true,
					noContextFiles: true,
				},
				resourceLoaderReloadOptions: {
					deferProjectTrust: (complete) => {
						completeTrust = complete;
					},
					resolveProjectTrust: () => true,
				},
			});
			const { session } = await createAgentSessionFromServices({
				services: await completeServices(),
				model: getModel("anthropic", "claude-sonnet-4-5"),
				sessionManager: await recordedSession(["read", "ls", "startup_probe"]),
			});
			sessions.push(session);
			assert.deepEqual(
				session.getActiveToolNames().sort(),
				safeChange === "activate" ? ["find", "ls", "read"] : safeChange === "deactivate" ? ["ls"] : ["ls", "read"],
			);
			await completeTrust();
			await session.completeStartupResources((await completeServices()).resourceLoader);
			const observedTools = JSON.parse(session.sessionManager.getSessionName() ?? "null") as string[] | null;
			const expected =
				safeChange === "activate"
					? ["find", "ls", "read", "startup_probe"]
					: safeChange === "deactivate"
						? ["ls"]
						: ["ls", "read", "startup_probe"];
			assert.deepEqual(observedTools, expected);
			assert.deepEqual(
				session.getActiveToolNames().sort(),
				[...expected, ...(activate ? ["newcomer_probe"] : [])].sort(),
			);
		});
	}
}
