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
import type { ExtensionFactory } from "../src/core/extensions/types.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { getDefaultToolNames } from "../src/core/tools/index.js";
import { appendTestCompaction } from "./verbatim-compaction-test-helpers.ts";

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

const toolReferences = (names: string[]) =>
	names.map((name) => ({ name, description: name, parameters: Type.Object({}) }));

/** Append a system message that adds and removes tools, as a run records loadout changes. */
async function recordLoadoutChange(sessionManager: SessionManager, added: string[], removed: string[] = []) {
	return await sessionManager.appendMessage({
		role: "system",
		content: "",
		...(added.length > 0 ? { toolsAdded: toolReferences(added) } : {}),
		...(removed.length > 0 ? { toolsRemoved: toolReferences(removed) } : {}),
		timestamp: Date.now(),
	});
}

async function recordedSession(toolNames: string[]) {
	const sessionManager = SessionManager.inMemory(tempDir);
	await recordLoadoutChange(sessionManager, toolNames);
	return sessionManager;
}

/** An SDK tool registered like an extension tool: default-active, and not a built-in. */
const activeTool = {
	name: "active_tool",
	label: "Active",
	description: "Fixture",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
};

test("resume restores the recorded built-in and extension loadout (#10785)", async () => {
	const session = await createFileSession({ sessionManager: await recordedSession(["read", "ls", "inactive_tool"]) });
	assert.deepEqual(session.getActiveToolNames().sort(), ["inactive_tool", "ls", "read"]);
});

test("resume activates extension tools the transcript never added or removed (#11062)", async () => {
	// Tools registered inactive stay inactive.
	const session = await createFileSession({
		sessionManager: await recordedSession(["read", "ls"]),
		customTools: [activeTool],
	});
	assert.deepEqual(session.getActiveToolNames().sort(), ["active_tool", "ls", "read"]);
});

test("resume keeps tools removed before a compaction inactive (#11062)", async () => {
	const sessionManager = await recordedSession(["read", "ls", "active_tool"]);
	await recordLoadoutChange(sessionManager, ["inactive_tool"], ["active_tool"]);
	await sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
	await appendTestCompaction(sessionManager, 1000, 500);
	const session = await createFileSession({ sessionManager, customTools: [activeTool] });
	assert.deepEqual(session.getActiveToolNames().sort(), ["inactive_tool", "ls", "read"]);
});

test("tree navigation restores the target branch's loadout (#11075)", async () => {
	// The target branch never mentions active_tool, so it is active there. It removed ls.
	const sessionManager = await recordedSession(["read", "ls"]);
	await recordLoadoutChange(sessionManager, [], ["ls"]);
	const target = await sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	await recordLoadoutChange(sessionManager, ["ls"], ["active_tool"]);
	const session = await createFileSession({ sessionManager, customTools: [activeTool] });
	assert.deepEqual(session.getActiveToolNames().sort(), ["ls", "read"]);

	await session.navigateTree(target, { summarize: false });
	assert.deepEqual(session.getActiveToolNames().sort(), ["active_tool", "read"]);
});

test("tree navigation keeps registered tools outside the tools allowlist inactive", async () => {
	// An allowlist without mcp__ entries keeps MCP tools registered but inactive.
	const sessionManager = await recordedSession(["read"]);
	const target = await sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	const session = await createFileSession({
		sessionManager,
		tools: ["read"],
		customTools: [{ ...activeTool, name: "mcp__server__lookup", label: "Lookup", description: "MCP tool" }],
	});
	assert.deepEqual(session.getActiveToolNames(), ["read"]);

	await session.navigateTree(target, { summarize: false });
	assert.deepEqual(session.getActiveToolNames(), ["read"]);
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
			// active_tool registers once the deferred extensions load, and the transcript never mentioned it.
			assert.deepEqual(
				session.getActiveToolNames().sort(),
				modified ? ["active_tool", "read", "write"] : ["active_tool", "inactive_tool", "ls", "read"],
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
		// The handler saw active_tool, which the transcript never mentioned, and kept it.
		assert.deepEqual(session.getActiveToolNames().sort(), ["active_tool", "find", "inactive_tool", "read"]);
	});
}

/** The builtin intercom extension registers a default-active tool, so it is active in every session. */
const MANDATORY_RUNTIME_TOOLS = ["intercom"];

interface StartupExtensionTool {
	name: string;
	defaultActive?: false;
}

/**
 * A session whose project extension loads only after project trust completes, as with `-e` extensions or an
 * unresolved trust prompt. The extension registers `tools`, records the tools its `session_start` handler sees
 * as the session name, and activates `activate`. `earlyExtension` is already loaded when the session starts.
 */
async function createDeferredTrustSession(options: {
	sessionManager: SessionManager;
	tools: StartupExtensionTool[];
	activate?: string[];
	earlyExtension?: ExtensionFactory;
	sessionOptions?: Pick<CreateAgentSessionOptions, "tools" | "excludedTools">;
}) {
	const extensionDir = join(tempDir, ".atomic", "extensions");
	mkdirSync(extensionDir, { recursive: true });
	writeFileSync(
		join(extensionDir, "startup.ts"),
		`export default function(pi) {
			for (const tool of ${JSON.stringify(options.tools)}) {
				pi.registerTool({ ...tool, label: tool.name, description: "Fixture",
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
			}
			pi.on("session_start", () => {
				pi.setSessionName(JSON.stringify(pi.getActiveTools().sort()));
				pi.setActiveTools([...pi.getActiveTools(), ...${JSON.stringify(options.activate ?? [])}]);
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
			extensionFactories: options.earlyExtension ? [options.earlyExtension] : [],
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
		sessionManager: options.sessionManager,
		...options.sessionOptions,
	});
	sessions.push(session);
	return {
		session,
		/** Complete project trust and startup, then return the tools the extension's `session_start` saw. */
		async completeStartup() {
			await completeTrust();
			await session.completeStartupResources((await completeServices()).resourceLoader);
			return JSON.parse(session.sessionManager.getSessionName() ?? "null") as string[] | null;
		},
	};
}

for (const activate of [false, true]) {
	for (const safeChange of ["none", "activate", "deactivate"] as const) {
		test(`startup completion preserves tool choices, activation=${activate}, safeChange=${safeChange} (#3624)`, async () => {
			const { session, completeStartup } = await createDeferredTrustSession({
				sessionManager: await recordedSession(["read", "ls", "startup_probe"]),
				// newcomer_probe is default-active and never mentioned by the recording. optin_probe is opt-in.
				tools: [
					{ name: "startup_probe" },
					{ name: "newcomer_probe" },
					{ name: "optin_probe", defaultActive: false },
				],
				activate: activate ? ["optin_probe"] : [],
				earlyExtension: (pi) => {
					pi.on("session_start", () => {
						if (safeChange === "activate") pi.setActiveTools([...pi.getActiveTools(), "find"]);
						if (safeChange === "deactivate")
							pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "read"));
					});
				},
			});
			assert.deepEqual(
				session.getActiveToolNames().sort(),
				[
					...(safeChange === "activate"
						? ["find", "ls", "read"]
						: safeChange === "deactivate"
							? ["ls"]
							: ["ls", "read"]),
					...MANDATORY_RUNTIME_TOOLS,
				].sort(),
			);
			const observedTools = await completeStartup();
			// The recorded startup_probe is dropped once the loadout changes by deactivation. newcomer_probe was
			// registered after the recording and is active either way (#11062).
			const expected = [
				...(safeChange === "activate"
					? ["find", "ls", "read", "startup_probe"]
					: safeChange === "deactivate"
						? ["ls"]
						: ["ls", "read", "startup_probe"]),
				"newcomer_probe",
				...MANDATORY_RUNTIME_TOOLS,
			].sort();
			assert.deepEqual(observedTools, expected);
			assert.deepEqual(
				session.getActiveToolNames().sort(),
				[...expected, ...(activate ? ["optin_probe"] : [])].sort(),
			);
		});
	}
}

test("startup completion activates extension tools the transcript never mentioned (#11062)", async () => {
	// Resuming after installing the extension: the recording predates its tools, and the branch removed removed_probe.
	const sessionManager = await recordedSession(["read", "ls", "startup_probe", "removed_probe"]);
	await recordLoadoutChange(sessionManager, [], ["removed_probe"]);
	const { session, completeStartup } = await createDeferredTrustSession({
		sessionManager,
		tools: [
			{ name: "startup_probe" },
			{ name: "removed_probe" },
			{ name: "newcomer_probe" },
			{ name: "optin_probe", defaultActive: false },
		],
	});
	await completeStartup();
	assert.deepEqual(
		session.getActiveToolNames().sort(),
		["ls", "newcomer_probe", "read", "startup_probe", ...MANDATORY_RUNTIME_TOOLS].sort(),
	);
});

test("startup completion keeps a deactivated tool inactive while activating newly registered tools (#11062)", async () => {
	const { session, completeStartup } = await createDeferredTrustSession({
		sessionManager: await recordedSession(["read", "ls"]),
		tools: [{ name: "newcomer_probe" }],
		// early_probe registers before startup completes, so the first restore already decided about it.
		earlyExtension: (pi) => {
			pi.registerTool({ ...activeTool, name: "early_probe" });
		},
	});
	assert.ok(session.getActiveToolNames().includes("early_probe"));
	session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "early_probe"));
	await completeStartup();
	assert.deepEqual(
		session.getActiveToolNames().sort(),
		["ls", "newcomer_probe", "read", ...MANDATORY_RUNTIME_TOOLS].sort(),
	);
});

for (const options of [{ excludedTools: ["newcomer_probe"] }, { tools: ["-newcomer_probe"] }]) {
	test(`startup completion keeps ${Object.keys(options)[0]} entries inactive (#11062)`, async () => {
		const { session, completeStartup } = await createDeferredTrustSession({
			sessionManager: await recordedSession(["read", "ls", "startup_probe"]),
			tools: [{ name: "startup_probe" }, { name: "newcomer_probe" }, { name: "other_probe" }],
			sessionOptions: options,
		});
		await completeStartup();
		assert.deepEqual(
			session.getActiveToolNames().sort(),
			["ls", "other_probe", "read", "startup_probe", ...MANDATORY_RUNTIME_TOOLS].sort(),
		);
	});
}
