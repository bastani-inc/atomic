import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { getBuiltinPackageLocations } from "../../packages/coding-agent/src/core/builtin-packages.js";
import type { SubagentChildPolicy } from "../../packages/coding-agent/src/core/extensions/types.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createCodemodeExtension } from "../../packages/coding-agent/src/extensions/codemode/index.js";
import { LATEST_PROTOCOL_VERSION } from "../../packages/coding-agent/src/extensions/mcp/client/index.js";
import { loadMcpConfig, type McpExposure } from "../../packages/coding-agent/src/extensions/mcp/config.js";
import { createMcpExtension } from "../../packages/coding-agent/src/extensions/mcp/index.js";
import { closeServers, listen, readBody } from "../../packages/coding-agent/test/mcp-client/helpers.js";

const NATIVE_CHILD_SESSION_TIMEOUT_MS = 120_000;
const roots: string[] = [];
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;

afterEach(async () => {
	await closeServers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
});

async function nativeChild(
	options: Pick<CreateAgentSessionOptions, "tools" | "excludedTools" | "noTools"> & {
		mcpDirectTools?: SubagentChildPolicy["mcpDirectTools"];
		exposure?: McpExposure;
		toolExposure?: Record<string, McpExposure>;
		toolNames?: string[];
		bundledShim?: boolean;
		trusted?: boolean;
	},
) {
	const root = mkdtempSync(join(tmpdir(), "atomic-native-mcp-child-"));
	roots.push(root);
	const calls: string[] = [];
	const origin = await listen(async (request, response) => {
		if (request.method !== "POST") {
			response.statusCode = request.method === "DELETE" ? 200 : 405;
			response.end();
			return;
		}
		const message = JSON.parse(await readBody(request)) as {
			id?: number;
			method: string;
			params?: { name: string };
		};
		if (message.id === undefined) {
			response.statusCode = 202;
			response.end();
			return;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fixture", version: "1" },
					}
				: message.method === "tools/list"
					? {
							tools: (options.toolNames ?? ["search_code", "delete_repo"]).map((name) => ({
								name,
								inputSchema: { type: "object" },
							})),
						}
					: { content: [{ type: "text", text: "selected tool ran" }] };
		if (message.method === "tools/call") calls.push(message.params!.name);
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	const config = { url: `${origin}/mcp`, exposure: options.exposure ?? "direct", toolExposure: options.toolExposure };
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	const configPath = join(agentDir, "mcp.json");
	writeFileSync(configPath, JSON.stringify({ mcpServers: { github: config } }));
	assert.deepEqual(loadMcpConfig({ agentDir, cwd: root, projectTrusted: false }).errors, []);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		builtinPackagePaths: options.bundledShim
			? getBuiltinPackageLocations()
					.filter((location) => location.distDirName === "mcp")
					.map((location) => location.packageDir)
			: [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			...(options.bundledShim
				? []
				: [
						{
							name: "mcp",
							builtin: options.trusted !== false,
							bundled: options.trusted !== false,
							factory: createMcpExtension({
								loadConfig: () => ({
									servers: [{ name: "github", config, source: "fixture", scope: "global" }],
									errors: [],
								}),
								logPath: join(root, "mcp.log"),
							}),
						},
					]),
			createCodemodeExtension({ models: false }),
		],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: join(root, "agent"),
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
		model: getModel("anthropic", "claude-sonnet-4-5"),
		tools: options.tools,
		excludedTools: options.excludedTools,
		noTools: options.noTools,
		customTools: [
			{
				name: "unselected_custom",
				label: "Unselected",
				description: "Must remain unavailable",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			},
		],
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			depth: 1,
			mcpDirectTools: options.mcpDirectTools,
		},
	});
	const errors: string[] = [];
	const stopErrors = session.extensionRunner.onError((error) => errors.push(`${error.extensionPath}: ${error.error}`));
	try {
		await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
		await session.extensionRunner.emitBeforeAgentStart("inspect repository", undefined, {
			cwd: root,
			forceSystemPrompt: "fixture",
		});
		assert.deepEqual(errors, []);
		return { session, calls };
	} catch (error) {
		session.dispose();
		throw error;
	} finally {
		stopErrors();
	}
}

test.each([{ tools: ["read"] }, { tools: ["read", "mcp__github__*"] }, { tools: ["re*"] }])(
	"an explicit child loadout $tools admits only its selected live native MCP tool",
	async ({ tools }) => {
		const { session, calls } = await nativeChild({ tools, mcpDirectTools: ["github/search_code"] });
		try {
			const selected = session.agent.state.tools.find((tool) => tool.name === "mcp__github__search_code");
			assert.ok(selected, `expected selected MCP tool, got ${session.getActiveToolNames().join(", ")}`);
			const result = await selected.execute("native-child-call", {}, new AbortController().signal);
			assert.equal(result.content[0]?.type, "text");
			assert.deepEqual(calls, ["search_code"]);
			const names = session.getAllTools().map((tool) => tool.name);
			assert.equal(names.includes("mcp__github__delete_repo"), false);
			assert.equal(names.includes("unselected_custom"), false);
			assert.equal(names.includes("bash"), false);
			assert.equal(session.getActiveToolNames().includes("codemode"), false);
			assert.equal(session.getActiveToolNames().includes("tool_search"), false);
		} finally {
			session.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"noTools all keeps native MCP selectors disabled in a child session",
	async () => {
		const { session, calls } = await nativeChild({
			noTools: "all",
			tools: ["*"],
			mcpDirectTools: ["github/search_code"],
		});
		try {
			assert.deepEqual(session.getActiveToolNames(), []);
			assert.equal(
				session.getAllTools().some((tool) => tool.name.startsWith("mcp__")),
				false,
			);
			assert.deepEqual(calls, []);
		} finally {
			session.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"the bundled native MCP shim preserves child selection ownership and prewarms codemode servers",
	async () => {
		const { session, calls } = await nativeChild({
			bundledShim: true,
			exposure: "codemode",
			tools: ["read"],
			mcpDirectTools: ["github/search_code"],
		});
		try {
			const selected = session.agent.state.tools.find((tool) => tool.name === "mcp__github__search_code");
			assert.ok(selected, `expected selected bundled MCP tool, got ${session.getActiveToolNames().join(", ")}`);
			await selected.execute("bundled-child-call", {}, new AbortController().signal);
			assert.deepEqual(calls, ["search_code"]);
			assert.equal(
				session.getAllTools().some((tool) => tool.name === "mcp__github__delete_repo"),
				false,
			);
		} finally {
			session.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);

test.each([
	{ selection: ["github/search_code"], expected: ["mcp__github__search_code"] },
	{ selection: undefined, expected: [] },
])(
	"an explicit codemode child cannot discover or call unselected MCP tools ($expected)",
	async ({ selection, expected }) => {
		const { session, calls } = await nativeChild({ tools: ["read", "codemode"], mcpDirectTools: selection });
		try {
			const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
			assert.ok(codemode);
			const result = await codemode.execute(
				"restricted-script",
				{
					code: 'let denied = false; try { await tools.mcp__github__delete_repo({}); } catch { denied = true; } return { names: (await searchTools("mcp__github")).map(tool => tool.name), denied };',
				},
				new AbortController().signal,
			);
			const output = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			assert.deepEqual(JSON.parse(output.split("\n").at(-1)!), { names: expected, denied: true });
			assert.deepEqual(calls, []);
		} finally {
			session.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"an ordinary exact native tool name remains usable in an explicit child loadout",
	async () => {
		const { session, calls } = await nativeChild({
			tools: ["read", "mcp__github__search_code"],
			exposure: "codemode",
		});
		try {
			const selected = session.agent.state.tools.find((tool) => tool.name === "mcp__github__search_code");
			assert.ok(selected);
			await selected.execute("exact-native-call", {}, new AbortController().signal);
			assert.deepEqual(calls, ["search_code"]);
			assert.equal(
				session.getAllTools().some((tool) => tool.name === "mcp__github__delete_repo"),
				false,
			);
		} finally {
			session.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);

test.each([
	{ restriction: "an excluded native name", excludedTools: ["mcp__github__search_code"] },
	{ restriction: "an untrusted native registrant", trusted: false },
])(
	"child selectors cannot bypass $restriction",
	async ({ excludedTools, trusted }) => {
		const { session } = await nativeChild({
			tools: ["read"],
			mcpDirectTools: ["github/search_code"],
			excludedTools,
			trusted,
		});
		try {
			assert.deepEqual(session.getActiveToolNames(), ["read"]);
			assert.equal(
				session.getAllTools().some((tool) => tool.name.startsWith("mcp__")),
				false,
			);
		} finally {
			session.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"configured hidden native tools stay unavailable even when selected by a child",
	async () => {
		const { session } = await nativeChild({
			tools: ["read"],
			mcpDirectTools: ["github/search_code"],
			toolExposure: { search_code: "hidden" },
		});
		try {
			assert.deepEqual(session.getActiveToolNames(), ["read"]);
		} finally {
			session.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);

test.each([
	{ tool: "read-file", sibling: "read_file" },
	{ tool: "a".repeat(90), sibling: "delete_repo" },
])(
	"child selection calls the raw MCP tool behind its assigned provider name ($tool)",
	async ({ tool, sibling }) => {
		const { session, calls } = await nativeChild({
			tools: ["read"],
			mcpDirectTools: [`github/${tool}`],
			toolNames: [tool, sibling],
		});
		try {
			const selected = session.agent.state.tools.filter((entry) => entry.name.startsWith("mcp__"));
			assert.equal(selected.length, 1);
			assert.ok(selected[0]!.name.length <= 64);
			assert.match(selected[0]!.name, /_[a-f0-9]{8}$/);
			await selected[0]!.execute("raw-identity-call", {}, new AbortController().signal);
			assert.deepEqual(calls, [tool]);
		} finally {
			session.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);

test.each([
	{ selection: undefined, expected: ["mcp__github__delete_repo", "mcp__github__search_code"] },
	{ selection: [], expected: [] },
])(
	"unrestricted children preserve MCP defaults unless explicitly disabled ($selection)",
	async ({ selection, expected }) => {
		const { session } = await nativeChild({ mcpDirectTools: selection });
		try {
			assert.deepEqual(
				session
					.getActiveToolNames()
					.filter((name) => name.startsWith("mcp__"))
					.sort(),
				expected,
			);
		} finally {
			session.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a wildcard parent admits an exact child read tool without widening its ceiling",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-wildcard-parent-"));
		roots.push(root);
		const { session: parent } = await createAgentSession({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(root),
			model: getModel("anthropic", "claude-sonnet-4-5"),
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
			tools: ["re*", "subagent"],
		});
		try {
			const resolver = parent.extensionRunner.createContext().getChildSessionOptions;
			assert.ok(resolver);
			const childOptions = resolver({
				tools: ["read", "bash", "read_mcp_resource"],
				sessionManager: SessionManager.inMemory(root),
			});
			assert.deepEqual(childOptions.tools, ["read"]);
			const { session: child } = await createAgentSession(childOptions);
			try {
				assert.deepEqual(child.getActiveToolNames(), ["read"]);
				assert.deepEqual(
					child.getAllTools().map((tool) => tool.name),
					["read"],
				);
			} finally {
				child.dispose();
			}
		} finally {
			parent.dispose();
		}
	},
	NATIVE_CHILD_SESSION_TIMEOUT_MS,
);
