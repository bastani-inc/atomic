import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	createUnstartedAgentSessionFromServices,
} from "../src/core/agent-session-services.ts";
import { getBuiltinPackageLocations } from "../src/core/builtin-packages.ts";
import type { ExtensionContext } from "../src/core/extensions/index.ts";
import { createExtensionRuntime, getExtensionRuntimeEventBus } from "../src/core/extensions/loader.ts";
import { publishExtensionContextEffect } from "../src/core/extensions/runner-context.ts";
import type { ResourceLoader } from "../src/core/resource-loader-types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { linkSharedTranspileCache } from "./helpers/shared-transpile-cache.ts";

const tempDirs: string[] = [];

function createFixture(name: string): { root: string; cwd: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), `atomic-deferred-reload-${name}-`));
	tempDirs.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	linkSharedTranspileCache(agentDir);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				testloop: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "test-key",
					models: [
						{
							id: "test-model",
							name: "test-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 1024,
						},
					],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "testloop",
			defaultModel: "test-model",
			sessionSummary: { enabled: false },
		}),
	);
	return { root, cwd, agentDir };
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("deferred startup reload", () => {
	it("keeps --no-mcp deferred in phase 1 and reuses phase-1 intercom without shutdown during startup completion", async () => {
		const { cwd, agentDir } = createFixture("nomcp-reuse");
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { disabledBuiltinExtensions: ["mcp"] },
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const { session } = await createUnstartedAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { mcp: false },
		});
		try {
			await session.bindExtensions({ mode: "tui", reportStartupErrors: true });
			const phase1Extensions = session.resourceLoader.getExtensions().extensions;
			assert.equal(
				phase1Extensions.length,
				1,
				`Phase 1 deferred --no-mcp should load only mandatory intercom, got: ${phase1Extensions.map((e) => e.path).join(", ")}`,
			);
			const phase1Intercom = phase1Extensions[0]!;
			assert.ok(phase1Intercom.tools.has("intercom"));

			let intercomShutdowns = 0;
			const shutdownHandlers = phase1Intercom.handlers.get("session_shutdown") ?? [];
			phase1Intercom.handlers.set("session_shutdown", [
				...shutdownHandlers,
				() => {
					intercomShutdowns++;
				},
			]);

			await session.reload({ reason: "startup" });

			const phase2Extensions = session.resourceLoader.getExtensions().extensions;
			assert.equal(
				intercomShutdowns,
				0,
				"Phase-1 intercom must not receive session_shutdown during startup completion",
			);
			assert.ok(
				phase2Extensions.includes(phase1Intercom),
				"Phase-1 intercom instance must be reused in place when settings and trust did not change",
			);
			const mcpLoc = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "mcp")!;
			assert.equal(
				phase2Extensions.some((ext) => ext.resolvedPath.startsWith(mcpLoc.packageDir)),
				false,
				"mcp must stay disabled under --no-mcp",
			);
			assert.ok(session.getActiveToolNames().includes("subagent"));
			assert.ok(session.getActiveToolNames().includes("web_search"));
			assert.ok(session.getActiveToolNames().includes("intercom"));
		} finally {
			await session.dispose();
		}
	});

	it.each([
		{ label: "with --no-mcp", noMcp: true },
		{ label: "with MCP enabled", noMcp: false },
	])(
		"produces byte-identical tools, commands, extensions order, and systemPrompt vs eager startup ($label)",
		async ({ noMcp }) => {
			const { cwd, agentDir } = createFixture(`parity-${noMcp ? "nomcp" : "mcp"}`);
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(
				join(agentDir, "extensions", "alpha.ts"),
				`export default function (pi) {
				pi.registerCommand("alpha-cmd", { description: "Alpha command", handler: async () => {} });
				pi.registerTool({
					name: "alpha_tool",
					label: "Alpha",
					description: "Alpha tool",
					parameters: { type: "object", properties: {} },
					async execute() { return { content: [{ type: "text", text: "ok" }] }; },
				});
			}\n`,
			);

			const run = async (defer: boolean) => {
				const sessionManager = SessionManager.inMemory(cwd);
				await sessionManager.appendCustomEntry("tool_loadout", {
					activeTools: ["read", "bash", "intercom", "alpha_tool"],
				});
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
					resourceLoaderOptions: { disabledBuiltinExtensions: noMcp ? ["mcp"] : undefined },
					resourceLoaderReloadOptions: defer ? { deferExtensions: true, deferResources: true } : undefined,
				});
				const { session } = await createUnstartedAgentSessionFromServices({
					services,
					sessionManager,
					builtins: noMcp ? { mcp: false } : undefined,
				});
				try {
					await session.bindExtensions({ mode: "tui", reportStartupErrors: true });
					const phase1Intercom = session.resourceLoader.getExtensions().extensions[0];
					if (defer) await session.reload({ reason: "startup" });
					const extensions = session.resourceLoader.getExtensions().extensions;
					if (defer) {
						assert.ok(
							extensions.includes(phase1Intercom!),
							"deferred startup should reuse phase-1 intercom when unchanged",
						);
					}
					return {
						extensionPaths: extensions.map((ext) => ext.resolvedPath),
						commands: session.extensionRunner.getRegisteredCommands().map((cmd) => cmd.name),
						activeTools: session.getActiveToolNames(),
						agentTools: session.agent.state.tools.map((tool) => tool.name),
						skills: session.resourceLoader.getSkills().skills.map((skill) => skill.name),
						systemPrompt: session.systemPrompt,
					};
				} finally {
					await session.dispose();
				}
			};

			const eager = await run(false);
			const deferred = await run(true);
			assert.deepEqual(deferred.extensionPaths, eager.extensionPaths);
			assert.deepEqual(deferred.commands, eager.commands);
			assert.deepEqual(deferred.activeTools, eager.activeTools);
			assert.deepEqual(deferred.agentTools, eager.agentTools);
			assert.deepEqual(deferred.skills, eager.skills);
			assert.equal(deferred.systemPrompt, eager.systemPrompt);
		},
	);

	it("respects --no-extensions --no-mcp while preserving child builtins and uncovered SDK builtins", async () => {
		const { cwd, agentDir } = createFixture("no-ext-nomcp");
		let childCtx: ExtensionContext | undefined;
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				noExtensions: true,
				disabledBuiltinExtensions: ["mcp"],
				extensionFactories: [
					{
						name: "probe",
						factory: (pi) => {
							pi.on("session_start", (_event, ctx) => {
								childCtx = ctx;
							});
						},
					},
				],
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { mcp: false },
		});
		try {
			const toolNames = session.getActiveToolNames();
			assert.ok(toolNames.includes("intercom"));
			assert.equal(toolNames.includes("subagent"), false, "--no-extensions --no-mcp must not load subagent");
			assert.equal(toolNames.includes("web_search"), false, "--no-extensions --no-mcp must not load web_search");
			const childOptions = childCtx!.getChildSessionOptions!({ sessionManager: SessionManager.inMemory(cwd) });
			assert.equal(childOptions.builtins?.mcp, false);
		} finally {
			await session.dispose();
		}

		// Uncovered SDK builtins ({ subagents: false } when services did not disable subagents) must still disable subagents + its skills.
		const uncoveredServices = await createAgentSessionServices({ cwd, agentDir });
		const { session: uncovered } = await createAgentSessionFromServices({
			services: uncoveredServices,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { subagents: false },
		});
		try {
			assert.equal(uncovered.getActiveToolNames().includes("subagent"), false);
			const subagentsLoc = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "subagents")!;
			assert.equal(
				uncovered.resourceLoader.getSkills().skills.some((s) => s.filePath.startsWith(subagentsLoc.packageDir)),
				false,
			);
		} finally {
			await uncovered.dispose();
		}

		// Custom ResourceLoader passed directly to createAgentSession still receives shipped builtins minus disabled ones.
		const emptyExtensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		const customLoader: ResourceLoader = {
			getExtensions: () => emptyExtensions,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: async () => {},
			reload: async () => {},
		};
		const { session: customSession } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader: customLoader,
			builtins: { mcp: false },
		});
		try {
			assert.ok(customSession.getActiveToolNames().includes("subagent"));
			assert.ok(customSession.getActiveToolNames().includes("web_search"));
			assert.ok(customSession.getActiveToolNames().includes("intercom"));
			const mcpLoc = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "mcp")!;
			assert.equal(
				customSession.resourceLoader
					.getExtensions()
					.extensions.some((ext) => ext.resolvedPath.startsWith(mcpLoc.packageDir)),
				false,
			);
		} finally {
			await customSession.dispose();
		}
	});

	it("falls back to full reload when settings or trust change between phase 1 and phase 2, and discovers added project files fresh", async () => {
		// (a) Settings edited between Phase 1 and Phase 2 -> full reload picks up edits
		const fxSettings = createFixture("settings-edit");
		const servicesA = await createAgentSessionServices({
			cwd: fxSettings.cwd,
			agentDir: fxSettings.agentDir,
			resourceLoaderOptions: { disabledBuiltinExtensions: ["mcp"] },
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const { session: sessionA } = await createUnstartedAgentSessionFromServices({
			services: servicesA,
			sessionManager: SessionManager.inMemory(fxSettings.cwd),
			builtins: { mcp: false },
		});
		try {
			await sessionA.bindExtensions({ mode: "tui", reportStartupErrors: true });
			const phase1Intercom = sessionA.resourceLoader.getExtensions().extensions[0]!;
			writeFileSync(
				join(fxSettings.agentDir, "settings.json"),
				JSON.stringify({
					defaultProvider: "testloop",
					defaultModel: "test-model",
					sessionSummary: { enabled: false },
					defaultTools: ["read", "bash"],
				}),
			);
			await sessionA.reload({ reason: "startup" });
			assert.equal(
				sessionA.resourceLoader.getExtensions().extensions.includes(phase1Intercom),
				false,
				"Settings edit between Phase 1 and Phase 2 must trigger full reload",
			);
			assert.deepEqual(sessionA.settingsManager.getDefaultTools(), ["read", "bash"]);
		} finally {
			await sessionA.dispose();
		}

		// (b) Project trust changes between Phase 1 and Phase 2 -> full reload picks up project settings
		const fxTrust = createFixture("trust-change");
		mkdirSync(join(fxTrust.cwd, ".atomic"), { recursive: true });
		writeFileSync(join(fxTrust.cwd, ".atomic", "settings.json"), JSON.stringify({ hideThinkingBlock: true }));
		const smTrust = await SettingsManager.createAsync(fxTrust.cwd, fxTrust.agentDir, { projectTrusted: false });
		const servicesB = await createAgentSessionServices({
			cwd: fxTrust.cwd,
			agentDir: fxTrust.agentDir,
			settingsManager: smTrust,
			resourceLoaderOptions: { disabledBuiltinExtensions: ["mcp"] },
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const { session: sessionB } = await createUnstartedAgentSessionFromServices({
			services: servicesB,
			sessionManager: SessionManager.inMemory(fxTrust.cwd),
			builtins: { mcp: false },
		});
		try {
			await sessionB.bindExtensions({ mode: "tui", reportStartupErrors: true });
			const phase1Intercom = sessionB.resourceLoader.getExtensions().extensions[0]!;
			await smTrust.setProjectTrustedAsync(true);
			await sessionB.reload({ reason: "startup" });
			assert.equal(
				sessionB.resourceLoader.getExtensions().extensions.includes(phase1Intercom),
				false,
				"Project trust change between Phase 1 and Phase 2 must trigger full reload",
			);
			assert.equal(sessionB.settingsManager.getHideThinkingBlock(), true);
		} finally {
			await sessionB.dispose();
		}

		// (c) Project files (AGENTS.md, skill, project extension) added between Phase 1 and Phase 2 are discovered fresh
		const fxProj = createFixture("proj-added");
		const smProj = await SettingsManager.createAsync(fxProj.cwd, fxProj.agentDir, { projectTrusted: true });
		const servicesC = await createAgentSessionServices({
			cwd: fxProj.cwd,
			agentDir: fxProj.agentDir,
			settingsManager: smProj,
			resourceLoaderOptions: { disabledBuiltinExtensions: ["mcp"] },
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const { session: sessionC } = await createUnstartedAgentSessionFromServices({
			services: servicesC,
			sessionManager: SessionManager.inMemory(fxProj.cwd),
			builtins: { mcp: false },
		});
		try {
			await sessionC.bindExtensions({ mode: "tui", reportStartupErrors: true });
			const phase1Intercom = sessionC.resourceLoader.getExtensions().extensions[0]!;
			writeFileSync(join(fxProj.cwd, "AGENTS.md"), "# Fresh Project Context\n");
			mkdirSync(join(fxProj.cwd, ".atomic", "skills", "fresh-skill"), { recursive: true });
			writeFileSync(
				join(fxProj.cwd, ".atomic", "skills", "fresh-skill", "SKILL.md"),
				"---\nname: fresh-skill\ndescription: Added before bound.\n---\n# Fresh\n",
			);
			mkdirSync(join(fxProj.cwd, ".atomic", "extensions"), { recursive: true });
			writeFileSync(
				join(fxProj.cwd, ".atomic", "extensions", "late.ts"),
				`export default function (pi) {
					pi.registerCommand("late-cmd", { description: "Late command", handler: async () => {} });
				}\n`,
			);
			await sessionC.reload({ reason: "startup" });
			assert.ok(sessionC.resourceLoader.getExtensions().extensions.includes(phase1Intercom));
			assert.ok(sessionC.systemPrompt.includes("Fresh Project Context"));
			assert.ok(sessionC.resourceLoader.getSkills().skills.some((s) => s.name === "fresh-skill"));
			assert.ok(sessionC.extensionRunner.getRegisteredCommands().some((c) => c.name === "late-cmd"));
		} finally {
			await sessionC.dispose();
		}
	});

	it("preserves phase-1 intercom runtime and EventBus on pre-commit failure, isolates leaked listeners, and succeeds on retry", async () => {
		const { cwd, agentDir } = createFixture("rollback-retry");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		const newcomerFile = join(agentDir, "extensions", "bus-ext.ts");
		writeFileSync(
			newcomerFile,
			`export default function (pi) {
				pi.events.on("deferred:probe", (payload) => {
					payload.hits.push("newcomer");
				});
				pi.on("session_start", () => {
					pi.events.emit("deferred:phase1", { from: "newcomer" });
				});
			}\n`,
		);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { disabledBuiltinExtensions: ["mcp"] },
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const { session } = await createUnstartedAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { mcp: false },
		});
		try {
			await session.bindExtensions({ mode: "tui", reportStartupErrors: true });
			const phase1Intercom = session.resourceLoader.getExtensions().extensions[0]!;
			const liveBus = getExtensionRuntimeEventBus(session.resourceLoader.getExtensions().runtime);
			const receivedFromNewcomer: unknown[] = [];
			liveBus.on("deferred:phase1", (data) => receivedFromNewcomer.push(data));

			// Fail before commit via beforeSessionStart
			await expect(
				session.reload({
					reason: "startup",
					beforeSessionStart: async () => {
						throw new Error("simulated pre-commit abort");
					},
				}),
			).rejects.toThrow("simulated pre-commit abort");

			// Live Phase-1 intercom must NOT be invalidated, and uncommitted newcomer's bus listener must NOT leak!
			const probeAfterRollback = { hits: [] as string[] };
			liveBus.emit("deferred:probe", probeAfterRollback);
			assert.deepEqual(probeAfterRollback.hits, [], "Rolled-back newcomer must not leak EventBus listeners");
			assert.equal(session.resourceLoader.getExtensions().extensions.length, 1);
			assert.equal(session.resourceLoader.getExtensions().extensions[0], phase1Intercom);

			// Retry succeeds cleanly and merges newcomer EventBus with Phase-1 EventBus
			await session.reload({ reason: "startup" });
			assert.ok(session.resourceLoader.getExtensions().extensions.includes(phase1Intercom));
			assert.deepEqual(receivedFromNewcomer, [{ from: "newcomer" }]);
			const probeAfterCommit = { hits: [] as string[] };
			liveBus.emit("deferred:probe", probeAfterCommit);
			assert.deepEqual(probeAfterCommit.hits, ["newcomer"]);
		} finally {
			await session.dispose();
		}
	});

	it("leaves runner unsealed for newcomer effects and runs full cache-clearing reload on subsequent /reload", async () => {
		const { cwd, agentDir } = createFixture("unsealed-and-later-reload");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		const extFile = join(agentDir, "extensions", "editable.ts");
		writeFileSync(
			extFile,
			`export default function (pi) {
				pi.registerCommand("ver", { description: "v1", handler: async () => {} });
				pi.on("session_start", async (_event, ctx) => {
					pi.appendEntry("deferred-startup-marker", { version: 1 });
				});
			}\n`,
		);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { disabledBuiltinExtensions: ["mcp"] },
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const { session } = await createUnstartedAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { mcp: false },
		});
		try {
			await session.bindExtensions({ mode: "tui", reportStartupErrors: true });
			const phase1Intercom = session.resourceLoader.getExtensions().extensions[0]!;
			await session.reload({ reason: "startup" });

			assert.ok(session.resourceLoader.getExtensions().extensions.includes(phase1Intercom));
			assert.equal(session.extensionRunner.getCommand("ver")?.description, "v1");
			assert.ok(
				session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "deferred-startup-marker"),
				"Newcomer session_start appendEntry must succeed without SessionClosed",
			);

			// publishExtensionContextEffect must run immediately on the live runner
			let commitEffectRan = false;
			await publishExtensionContextEffect(
				session.extensionRunner.createContext(),
				() => {
					commitEffectRan = true;
				},
				"commit",
			);
			assert.equal(commitEffectRan, true);

			// Modify extension on disk and run user /reload -> must clear cache and pick up v2!
			writeFileSync(
				extFile,
				`export default function (pi) {
					pi.registerCommand("ver", { description: "v2", handler: async () => {} });
				}\n`,
			);
			await session.reload();
			assert.equal(
				session.resourceLoader.getExtensions().extensions.includes(phase1Intercom),
				false,
				"Later /reload must run a full reload, not reuse phase-1 intercom",
			);
			assert.equal(session.extensionRunner.getCommand("ver")?.description, "v2");
		} finally {
			await session.dispose();
		}
	});

	it("stages newcomer provider registrations against pre-commit rollback and publishes them on retry", async () => {
		const { cwd, agentDir } = createFixture("provider-rollback");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "provider-ext.ts"),
			`export default function (pi) {
				pi.registerProvider("staged-prov", {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "test-key",
					models: [{
						id: "staged-model",
						name: "staged-model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 256,
					}],
				});
			}\n`,
		);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { disabledBuiltinExtensions: ["mcp"] },
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const { session } = await createUnstartedAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { mcp: false },
		});
		try {
			await session.bindExtensions({ mode: "tui", reportStartupErrors: true });
			await expect(
				session.reload({
					reason: "startup",
					beforeSessionStart: async () => {
						throw new Error("abort before provider commit");
					},
				}),
			).rejects.toThrow("abort before provider commit");

			assert.equal(
				session.modelRuntime.getModel("staged-prov", "staged-model"),
				undefined,
				"Rolled-back newcomer provider must not leak into live ModelRuntime",
			);

			await session.reload({ reason: "startup" });
			assert.ok(
				session.modelRuntime.getModel("staged-prov", "staged-model"),
				"Retry must publish newcomer provider transactionally",
			);
		} finally {
			await session.dispose();
		}
	});

	it("falls back to full transactional rollback on strict startup when a newcomer throws in session_start", async () => {
		const { cwd, agentDir } = createFixture("strict-rollback");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "throw-start.ts"),
			`export default function (pi) {
				pi.registerCommand("never-committed", { description: "should roll back", handler: async () => {} });
				pi.on("session_start", () => {
					throw new Error("strict startup boom");
				});
			}\n`,
		);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { disabledBuiltinExtensions: ["mcp"] },
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const { session } = await createUnstartedAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { mcp: false },
		});
		try {
			await session.bindExtensions({ mode: "rpc", reportStartupErrors: false });
			await expect(session.reload({ reason: "startup" })).rejects.toThrow("strict startup boom");
			assert.equal(
				session.extensionRunner.getCommand("never-committed"),
				undefined,
				"Strict startup rollback must leave failing candidate uncommitted",
			);
		} finally {
			await session.dispose();
		}
	});
});
