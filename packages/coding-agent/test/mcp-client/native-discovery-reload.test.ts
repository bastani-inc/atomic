import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createTestUiContext } from "./native-test-ui.ts";

// The real CLI completes lazy startup via a transactional reload of an initially empty loader.
// Unlike schema-only discovery tests, session_start must see the successor tool registry here.
it.each([
	{ exposure: undefined, expected: "codemode" },
	{ exposure: "deferred" as const, expected: "tool_search" },
])(
	"lazy transactional startup activates native $expected discovery without an unreachable warning",
	async ({ exposure, expected }) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-native-discovery-reload-"));
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		const notifications: string[] = [];
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [
				...builtInExtensions,
				createMcpExtension({
					loadConfig: () => ({
						servers: [
							{
								name: "echo",
								source: "test",
								config: {
									command: process.execPath,
									args: [join(import.meta.dirname, "fixtures/stdio-server.mjs")],
									...(exposure ? { exposure } : {}),
								},
							},
						],
						errors: [],
					}),
				}),
			],
		});
		await resourceLoader.reload({ deferExtensions: true, deferResources: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			model: getModel("openai", "gpt-6.1-sol-fast"),
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
		});
		try {
			await session.bindExtensions({
				uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
			});
			expect(session.getAllTools().some((tool) => tool.name === expected)).toBe(false);
			await session.reload({ reason: "startup", failOnExtensionErrors: true });
			expect(session.getAllTools().find((tool) => tool.name === expected)?.sourceInfo.path).toBe(
				expected === "codemode" ? "builtin:codemode" : "builtin:tool-search",
			);
			expect(session.getActiveToolNames()).toContain(expected);
			expect(notifications.some((message) => message.includes("neither is active"))).toBe(false);
		} finally {
			await session.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

it("candidate tool inspection and activation honor permissions and remain isolated through rollback", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-candidate-tool-view-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	let candidate = false;
	let rejectCandidate = true;
	let candidateTools: string[] = [];
	let candidateActive: string[] = [];
	let release!: () => void;
	let entered!: () => void;
	let entry = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				if (!candidate) return;
				for (const name of ["candidate_tool", "excluded_tool", "unlisted_tool", "hidden_tool"]) {
					pi.registerTool({
						name,
						label: name,
						description: name,
						parameters: Type.Object({}),
						defaultActive: false,
						...(name === "hidden_tool" ? { exposure: "hidden" as const } : {}),
						execute: async () => ({ content: [], details: {} }),
					});
				}
				pi.on("session_start", async () => {
					candidateTools = pi.getAllTools().map((tool) => tool.name);
					pi.setActiveTools(["read", "candidate_tool", "excluded_tool", "unlisted_tool", "hidden_tool"]);
					candidateActive = pi.getActiveTools();
					entered();
					await gate;
					if (rejectCandidate) throw new Error("reject successor after discovery");
				});
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		model: getModel("openai", "gpt-6.1-sol-fast"),
		sessionManager: SessionManager.inMemory(cwd),
		builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
		tools: ["read", "candidate_tool", "excluded_tool", "hidden_tool"],
		excludedTools: ["excluded_tool"],
	});
	try {
		await session.bindExtensions({});
		const originalTools = session.getAllTools();
		const originalActive = session.getActiveToolNames();
		candidate = true;
		for (const reject of [true, false]) {
			rejectCandidate = reject;
			const reload = session.reload({ failOnExtensionErrors: true });
			const outcome = reload.then(
				() => undefined,
				(error: Error) => error,
			);
			await entry;
			expect(candidateTools.sort()).toEqual(["candidate_tool", "hidden_tool", "read"]);
			expect(candidateActive).toEqual(["read", "candidate_tool"]);
			expect(session.getAllTools()).toEqual(originalTools);
			expect(session.getActiveToolNames()).toEqual(originalActive);
			release();
			const error = await outcome;
			if (reject) {
				expect(String(error)).toContain("Extension startup failed");
				expect(session.getAllTools()).toEqual(originalTools);
				expect(session.getActiveToolNames()).toEqual(originalActive);
				entry = new Promise<void>((resolve) => {
					entered = resolve;
				});
				gate = new Promise<void>((resolve) => {
					release = resolve;
				});
			} else {
				expect(error).toBeUndefined();
				expect(session.getActiveToolNames()).toEqual(["read", "candidate_tool"]);
			}
		}
	} finally {
		release();
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
