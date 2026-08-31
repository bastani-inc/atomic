import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel, type Model } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventBus } from "../src/core/event-bus.ts";
import { sessionScopedExtensionState } from "../src/core/extension-session-state.ts";
import type { ExtensionCommandContextActions } from "../src/core/extensions/index.ts";
import { DefaultResourceLoader, type ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PromptTurnHarness = {
	deferredStartupPending: boolean;
	deferredStartupPromise?: Promise<void>;
	session: {
		readonly isStreaming: boolean;
		subscribe: (listener: (event: { type: string }) => void) => () => void;
		resumeQueuedMessages: () => Promise<boolean>;
		prompt: (text: string) => Promise<void>;
	};
	showWorkingLoaderNow: () => void;
	ensureDeferredStartupComplete: () => Promise<void>;
	showLoadedResources: () => void;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
	discardDeferredRenderedUserInput: (text: string) => void;
	showError: (message: string) => void;
	stopWorkingLoader: () => void;
	startupNoticesContainer: Record<string, never>;
};

type InteractiveModePrivate = {
	runUserPromptTurn(this: PromptTurnHarness, userInput: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createCommandActions(): ExtensionCommandContextActions {
	return {
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true }),
		navigateTree: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		reload: async () => {},
	};
}

function writeProbeTheme(path: string, name: string): void {
	const source = fileURLToPath(new URL("../src/modes/interactive/theme/dark.json", import.meta.url));
	const theme = JSON.parse(readFileSync(source, "utf8")) as { name: string };
	writeFileSync(path, JSON.stringify({ ...theme, name }));
}

describe("interactive deferred startup first prompt readiness", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-deferred-first-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("loads extension tools, resources, and provider overrides before the first prompt", async () => {
		const skillFile = join(tempDir, "startup-skill.md");
		writeFileSync(
			skillFile,
			`---\nname: startup-skill\ndescription: Use when deferred startup resources are ready.\n---\n\n# Startup Skill\n`,
		);
		const deferredBaseUrl = "http://localhost:8080/deferred-startup";
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "startup_tool",
							label: "Startup Tool",
							description: "Tool registered during deferred startup",
							promptSnippet: "Use startup_tool for readiness checks.",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
						pi.registerProvider("anthropic", { baseUrl: deferredBaseUrl });
					});
					pi.on("resources_discover", () => ({ skillPaths: [skillFile] }));
				},
			],
		});
		await resourceLoader.reload({ deferExtensions: true, deferResources: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		try {
			expect(session.getActiveToolNames()).not.toContain("startup_tool");
			expect(session.getActiveToolNames()).toContain("intercom");
			expect(session.getAllTools().find((tool) => tool.name === "intercom")?.sourceInfo.configurationOrigin).toBe(
				"bundled",
			);
			expect(session.getToolDefinition("contact_supervisor")).toBeUndefined();
			expect(session.resourceLoader.getSkills().skills.map((skill) => skill.name)).not.toContain("startup-skill");

			let observedPromptText: string | undefined;
			let observedTools: string[] = [];
			let observedSkills: string[] = [];
			let observedBaseUrl: string | undefined;
			const order: string[] = [];
			const harness: PromptTurnHarness = {
				deferredStartupPending: true,
				deferredStartupPromise: undefined,
				session: {
					get isStreaming() {
						return session.isStreaming;
					},
					subscribe: vi.fn(() => () => {}),
					resumeQueuedMessages: vi.fn(async () => false),
					prompt: vi.fn(async (text: string) => {
						order.push("prompt");
						observedPromptText = text;
						observedTools = session.getActiveToolNames();
						observedSkills = session.resourceLoader.getSkills().skills.map((skill) => skill.name);
						observedBaseUrl = session.model?.baseUrl;
					}),
				},
				showWorkingLoaderNow: vi.fn(() => {
					order.push("spinner");
				}),
				ensureDeferredStartupComplete: vi.fn(async () => {
					order.push("deferred");
					await session.bindExtensions({ commandContextActions: createCommandActions() });
					await session.reload({ reason: "startup" });
					harness.deferredStartupPending = false;
				}),
				showLoadedResources: vi.fn(),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
				discardDeferredRenderedUserInput: vi.fn(),
				showError: vi.fn(),
				stopWorkingLoader: vi.fn(),
				startupNoticesContainer: {},
			};

			await interactiveModePrototype.runUserPromptTurn.call(harness, "hello");

			expect(harness.showError).not.toHaveBeenCalled();
			expect(order).toEqual(["spinner", "deferred", "prompt"]);
			expect(observedPromptText).toBe("hello");
			expect(observedTools).toContain("startup_tool");
			expect(observedTools).toContain("intercom");
			expect(observedSkills).toContain("startup-skill");
			expect(observedBaseUrl).toBe(deferredBaseUrl);
		} finally {
			session.dispose();
		}
	});
	it("holds a session_start provider turn until tools and extension resources publish", async () => {
		const skillFile = join(tempDir, "session-start-skill.md");
		writeFileSync(skillFile, "---\nname: session-start-skill\ndescription: Session start readiness\n---\n\nReady\n");
		let releaseDiscovery!: () => void;
		const discoveryBlocked = new Promise<void>((resolve) => {
			releaseDiscovery = resolve;
		});
		let discoveryStarted!: () => void;
		const discoveryEntered = new Promise<void>((resolve) => {
			discoveryStarted = resolve;
		});
		const providerId = "session-start-provider";
		const model: Model<"openai-completions"> = {
			id: "session-start-model",
			name: "Session Start Model",
			provider: providerId,
			api: "openai-completions",
			baseUrl: "http://localhost:8080/session-start-gated/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		};
		let modelSelectionAccepted: boolean | undefined;
		let observedPayload: Record<string, unknown> | undefined;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			observedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				`data: ${JSON.stringify({
					id: "session-start-response",
					choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
				})}\n\ndata: [DONE]\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						pi.registerTool({
							name: "session_start_tool",
							label: "Session Start Tool",
							description: "Published before the queued provider turn",
							promptSnippet: "The session-start tool is ready.",
							parameters: Type.Object({ nonce: Type.String() }),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
						pi.registerProvider(providerId, {
							api: model.api,
							apiKey: "test-key",
							baseUrl: model.baseUrl,
							models: [model],
						});
						modelSelectionAccepted = await pi.setModel(model);
						pi.sendUserMessage("session-start-provider-turn");
					});
					pi.on("resources_discover", async () => {
						discoveryStarted();
						await discoveryBlocked;
						return { skillPaths: [skillFile] };
					});
				},
			],
		});
		await resourceLoader.reload({ deferExtensions: true, deferResources: true });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			await session.bindExtensions({ commandContextActions: createCommandActions() });
			const reload = session.reload({ reason: "startup", failOnExtensionErrors: true });
			await discoveryEntered;
			expect(fetchMock).not.toHaveBeenCalled();
			expect(session.getActiveToolNames()).not.toContain("session_start_tool");
			expect(session.resourceLoader.getSkills().skills.map((skill) => skill.name)).not.toContain(
				"session-start-skill",
			);
			expect(session.model?.provider).toBe("anthropic");

			releaseDiscovery();
			await reload;
			expect(modelSelectionAccepted).toBe(true);
			expect(session.model).toEqual(expect.objectContaining({ provider: providerId, id: model.id }));
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["session_start_tool", "intercom"]));
			expect(session.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain("session-start-skill");
			const serializedPayload = JSON.stringify(observedPayload);
			expect(serializedPayload).toContain("session-start-provider-turn");
			expect(serializedPayload).toContain("session_start_tool");
			expect(serializedPayload).toContain('"required":["nonce"]');
			expect(serializedPayload).toContain("session-start-skill");
			expect(serializedPayload).toContain("The session-start tool is ready.");
		} finally {
			session.dispose();
			fetchMock.mockRestore();
		}
	});

	it("discards candidate events and session controls when resource publication fails", async () => {
		const themeFile = join(tempDir, "candidate-side-effect-theme.json");
		writeProbeTheme(themeFile, "candidate-side-effect-theme");
		let candidate = false;
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			themesOverride: (base) => {
				if (base.themes.some((theme) => theme.name === "candidate-side-effect-theme")) {
					throw new Error("candidate side-effect failure");
				}
				return base;
			},
			extensionFactories: [
				(pi) => {
					if (!candidate) {
						pi.events.on("candidate-start", () => pi.sendUserMessage("old-event-bus-dispatch"));
						return;
					}
					pi.on("session_start", (_event, ctx) => {
						pi.events.emit("candidate-start", undefined);
						pi.sendUserMessage("candidate-direct-dispatch");
						ctx.compact();
						ctx.abort();
						ctx.shutdown();
					});
					pi.on("resources_discover", () => ({ themePaths: [themeFile] }));
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			const shutdown = vi.fn();
			await session.bindExtensions({ commandContextActions: createCommandActions(), shutdownHandler: shutdown });
			const send = vi.spyOn(session, "sendUserMessage").mockResolvedValue();
			const compact = vi.spyOn(session, "compact").mockRejectedValue(new Error("must not run"));
			const abort = vi.spyOn(session, "abort").mockResolvedValue();
			candidate = true;

			await expect(session.reload({ reason: "reload", failOnExtensionErrors: true })).rejects.toThrow(
				"candidate side-effect failure",
			);
			expect(send).not.toHaveBeenCalled();
			expect(compact).not.toHaveBeenCalled();
			expect(abort).not.toHaveBeenCalled();
			expect(shutdown).not.toHaveBeenCalled();
		} finally {
			session.dispose();
		}
	});

	it("removes providers owned by extensions that disappear on reload", async () => {
		const providerId = "removed-extension-provider";
		let registerProvider = true;
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					if (!registerProvider) return;
					pi.registerProvider(providerId, {
						api: "openai-completions",
						baseUrl: "http://localhost:8080/removed-provider/v1",
						models: [{ id: "removed-model", name: "Removed model" }],
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			await session.bindExtensions({ commandContextActions: createCommandActions() });
			expect(session.modelRuntime.getRegisteredProviderIds()).toContain(providerId);
			expect(session.modelRuntime.getModel(providerId, "removed-model")).toBeDefined();
			registerProvider = false;

			await session.reload({ reason: "reload", failOnExtensionErrors: true });
			expect(session.modelRuntime.getRegisteredProviderIds()).not.toContain(providerId);
			expect(session.modelRuntime.getModel(providerId, "removed-model")).toBeUndefined();
		} finally {
			session.dispose();
		}
	});

	it("preserves the same session-scoped extension state across a successful staged reload", async () => {
		let observedLoads = 0;
		let initialState: { loads: number } | undefined;
		let reloadedState: { loads: number } | undefined;
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					const state = sessionScopedExtensionState(pi.events, "staged-reload", () => ({ loads: 0 }));
					if (initialState === undefined) initialState = state;
					else reloadedState = state;
					state.loads += 1;
					pi.on("session_start", () => {
						observedLoads = state.loads;
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			await session.bindExtensions({ commandContextActions: createCommandActions() });
			await session.reload({ reason: "reload", failOnExtensionErrors: true });
			expect(reloadedState).toBe(initialState);
			expect(observedLoads).toBe(2);
		} finally {
			session.dispose();
		}
	});

	it("keeps non-strict reload compatible with a custom loader and fails strict reload before mutation", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const delegate = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager, noExtensions: true });
		await delegate.reload();
		const reload = vi.fn((options?: Parameters<ResourceLoader["reload"]>[0]) => delegate.reload(options));
		const resourceLoader: ResourceLoader = {
			getExtensions: () => delegate.getExtensions(),
			getSkills: () => delegate.getSkills(),
			getSkillCatalog: () => delegate.getSkillCatalog(),
			getPrompts: () => delegate.getPrompts(),
			getThemes: () => delegate.getThemes(),
			getAgentsFiles: () => delegate.getAgentsFiles(),
			getSystemPrompt: () => delegate.getSystemPrompt(),
			getSystemPromptSource: () => delegate.getSystemPromptSource(),
			getAppendSystemPrompt: () => delegate.getAppendSystemPrompt(),
			getAppendSystemPromptSources: () => delegate.getAppendSystemPromptSources(),
			extendResources: (paths) => delegate.extendResources(paths),
			reload,
		};
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			await session.bindExtensions({ commandContextActions: createCommandActions() });
			await expect(session.reload({ reason: "startup" })).resolves.toBeUndefined();
			const successfulReloadCalls = reload.mock.calls.length;
			await expect(session.reload({ reason: "startup", failOnExtensionErrors: true })).rejects.toThrow(
				"requires a transactional resource loader",
			);
			expect(reload).toHaveBeenCalledTimes(successfulReloadCalls);
		} finally {
			session.dispose();
		}
	});

	it("publishes no candidate state when provider refresh fails at the final commit boundary", async () => {
		let candidate = false;
		let shutdownCount = 0;
		let emitLiveProbe!: () => void;
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					if (!candidate) {
						emitLiveProbe = () => pi.events.emit("publication-probe", undefined);
						pi.events.on("publication-probe", () => pi.sendUserMessage("old-live-handler"));
						pi.on("session_shutdown", () => {
							shutdownCount += 1;
						});
						return;
					}
					pi.events.on("publication-probe", () => pi.sendUserMessage("candidate-live-handler"));
					pi.registerTool({
						name: "late_candidate_tool",
						label: "Late Candidate Tool",
						description: "Must not publish when provider refresh fails",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "unexpected" }], details: {} }),
					});
					pi.registerProvider("late-candidate-provider", {
						api: "openai-completions",
						baseUrl: "http://localhost:8080/late-candidate/v1",
						models: [{ id: "late-model", name: "Late model" }],
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			await session.bindExtensions({ commandContextActions: createCommandActions() });
			const oldRunner = session.extensionRunner;
			const send = vi.spyOn(session, "sendUserMessage").mockResolvedValue();
			const before = {
				quietStartup: settingsManager.getQuietStartup(),
				providerIds: session.modelRuntime.getRegisteredProviderIds(),
				tools: session.getActiveToolNames(),
			};
			const internals = session.modelRuntime as unknown as {
				runRefresh(options: object, sequence: number, discardIfSuperseded?: boolean): Promise<unknown>;
			};
			vi.spyOn(internals, "runRefresh").mockRejectedValueOnce(new Error("late provider refresh failure"));
			candidate = true;
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));

			await expect(session.reload({ reason: "reload", failOnExtensionErrors: true })).rejects.toThrow(
				"late provider refresh failure",
			);
			expect(session.extensionRunner).toBe(oldRunner);
			expect(shutdownCount).toBe(0);
			expect(settingsManager.getQuietStartup()).toBe(before.quietStartup);
			expect(session.modelRuntime.getRegisteredProviderIds()).toEqual(before.providerIds);
			expect(session.modelRuntime.getModel("late-candidate-provider", "late-model")).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(before.tools);
			emitLiveProbe();
			await vi.waitFor(() => expect(send).toHaveBeenCalledWith("old-live-handler", undefined));
			expect(send).not.toHaveBeenCalledWith("candidate-live-handler", undefined);
		} finally {
			session.dispose();
		}
	});

	it("publishes nothing when staged event-bus subscription preparation fails", async () => {
		let candidate = false;
		let rejectSubscriptions = false;
		const handlers = new Map<string, Set<(data: unknown) => void>>();
		const eventBus: EventBus = {
			emit(channel, data) {
				for (const handler of handlers.get(channel) ?? []) handler(data);
			},
			on(channel, handler) {
				if (rejectSubscriptions) throw new Error("event bus rejected candidate subscription");
				const channelHandlers = handlers.get(channel) ?? new Set();
				channelHandlers.add(handler);
				handlers.set(channel, channelHandlers);
				return () => channelHandlers.delete(handler);
			},
		};
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			eventBus,
			extensionFactories: [
				(pi) => {
					const handlerMessage = candidate ? "candidate-event-handler" : "old-event-handler";
					pi.events.on("transaction-probe", () => pi.sendUserMessage(handlerMessage));
					if (candidate) {
						pi.registerProvider("event-bus-candidate", {
							api: "openai-completions",
							baseUrl: "http://localhost:8080/event-bus-candidate/v1",
							models: [{ id: "candidate-model", name: "Candidate model" }],
						});
					}
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			await session.bindExtensions({ commandContextActions: createCommandActions() });
			const oldRunner = session.extensionRunner;
			const beforeProviders = session.modelRuntime.getRegisteredProviderIds();
			const send = vi.spyOn(session, "sendUserMessage").mockResolvedValue();
			candidate = true;
			rejectSubscriptions = true;

			await expect(session.reload({ reason: "reload", failOnExtensionErrors: true })).rejects.toThrow(
				"event bus rejected candidate subscription",
			);
			expect(session.extensionRunner).toBe(oldRunner);
			expect(session.modelRuntime.getRegisteredProviderIds()).toEqual(beforeProviders);
			expect(session.modelRuntime.getModel("event-bus-candidate", "candidate-model")).toBeUndefined();
			rejectSubscriptions = false;
			eventBus.emit("transaction-probe", undefined);
			await vi.waitFor(() => expect(send).toHaveBeenCalledWith("old-event-handler", undefined));
			expect(send).not.toHaveBeenCalledWith("candidate-event-handler", undefined);
		} finally {
			session.dispose();
		}
	});

	it("rolls back settings, providers, tools, skills, prompts, themes, and system prompt on failure", async () => {
		const skillFile = join(tempDir, "rollback-skill.md");
		const promptFile = join(tempDir, "rollback-prompt.md");
		const themeFile = join(tempDir, "rollback-theme.json");
		const systemPromptFile = join(tempDir, "SYSTEM.md");
		writeFileSync(skillFile, "---\nname: rollback-skill\ndescription: Candidate only\n---\nCandidate");

		writeFileSync(promptFile, "---\ndescription: Candidate only\n---\nCandidate");
		writeProbeTheme(themeFile, "rollback-theme");
		writeFileSync(systemPromptFile, "live system prompt");
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			systemPrompt: systemPromptFile,
			themesOverride: (base) => {
				if (base.themes.some((theme) => theme.name === "rollback-theme")) {
					throw new Error("late candidate theme failure");
				}
				return base;
			},
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "partial_startup_tool",
						label: "Partial Startup Tool",
						description: "Must not publish when extension resources fail",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "unexpected" }], details: {} }),
					});
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/partial-provider" });
					pi.on("session_start", () => pi.sendUserMessage("must-not-dispatch"));
					pi.on("resources_discover", () => ({
						skillPaths: [skillFile],
						promptPaths: [promptFile],
						themePaths: [themeFile],
					}));
				},
			],
		});
		await resourceLoader.reload({ deferExtensions: true, deferResources: true });

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		try {
			await session.bindExtensions({ commandContextActions: createCommandActions() });
			const send = vi.spyOn(session, "sendUserMessage").mockResolvedValue();
			const before = {
				quietStartup: settingsManager.getQuietStartup(),
				providerBaseUrl: session.model?.baseUrl,
				registeredProviderIds: session.modelRuntime.getRegisteredProviderIds(),
				providerConfig: session.modelRuntime.getRegisteredProviderConfig("anthropic"),
				nativeProvider: session.modelRuntime.getRegisteredNativeProvider("anthropic"),
				tools: session.getActiveToolNames(),
				skills: session.resourceLoader.getSkills().skills.map((skill) => skill.name),
				prompts: session.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name),
				themes: session.resourceLoader.getThemes().themes.map((theme) => theme.name),
				loaderSystemPrompt: session.resourceLoader.getSystemPrompt(),
				sessionSystemPrompt: session.systemPrompt,
			};
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
			writeFileSync(systemPromptFile, "candidate system prompt");

			await expect(session.reload({ reason: "startup", failOnExtensionErrors: true })).rejects.toThrow(
				"late candidate theme failure",
			);
			expect(send).not.toHaveBeenCalled();
			expect({
				quietStartup: settingsManager.getQuietStartup(),
				providerBaseUrl: session.model?.baseUrl,
				registeredProviderIds: session.modelRuntime.getRegisteredProviderIds(),
				providerConfig: session.modelRuntime.getRegisteredProviderConfig("anthropic"),
				nativeProvider: session.modelRuntime.getRegisteredNativeProvider("anthropic"),
				tools: session.getActiveToolNames(),
				skills: session.resourceLoader.getSkills().skills.map((skill) => skill.name),
				prompts: session.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name),
				themes: session.resourceLoader.getThemes().themes.map((theme) => theme.name),
				loaderSystemPrompt: session.resourceLoader.getSystemPrompt(),
				sessionSystemPrompt: session.systemPrompt,
			}).toEqual(before);
			expect(session.getActiveToolNames()).toContain("intercom");
			expect(session.getActiveToolNames()).not.toContain("partial_startup_tool");
		} finally {
			session.dispose();
		}
	});
});
