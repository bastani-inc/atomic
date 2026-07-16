import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { ExtensionCommandContextActions } from "../src/core/extensions/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { applyDeferredModelScope } from "../src/modes/interactive/interactive-deferred-startup.ts";
import { trustedCursorProviderSource } from "./cursor-test-provider-source.ts";

type PromptTurnHarness = {
	deferredStartupPending: boolean;
	deferredStartupPromise?: Promise<void>;
	deferredStartupFatalError?: Error;
	deferLoadedResourcesDisclosureUntilAgentEnd: boolean;
	pendingLoadedResourcesDisclosure: boolean;
	session: { readonly isStreaming: boolean; prompt: (text: string) => Promise<void> };
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

const interactiveModePrototype = InteractiveMode.prototype as InteractiveModePrivate;

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
		writeFileSync(skillFile, `---\nname: startup-skill\ndescription: Use when deferred startup resources are ready.\n---\n\n# Startup Skill\n`);
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
			expect(session.resourceLoader.getSkills().skills.map((skill) => skill.name)).not.toContain("startup-skill");

			let observedPromptText: string | undefined;
			let observedTools: string[] = [];
			let observedSkills: string[] = [];
			let observedBaseUrl: string | undefined;
			const order: string[] = [];
			const harness: PromptTurnHarness = {
				deferredStartupPending: true,
				deferredStartupPromise: undefined,
				deferLoadedResourcesDisclosureUntilAgentEnd: false,
				pendingLoadedResourcesDisclosure: false,
				session: {
					get isStreaming() {
						return session.isStreaming;
					},
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
			expect(observedSkills).toContain("startup-skill");
			expect(observedBaseUrl).toBe(deferredBaseUrl);
		} finally {
			session.dispose();
		}
	});

	it.each(["cursor-route:high (1m)/exact", ""] as const)(
		"retries an exact settings-only Cursor default %j after real deferred extension loading before the first prompt",
		async (exactId) => {
			const order: string[] = [];
			const settingsManager = SettingsManager.create(tempDir, agentDir);
			settingsManager.setDefaultModelAndProvider("cursor", exactId);
			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.inMemory();
			const modelRegistry = ModelRegistry.inMemory(authStorage, trustedCursorProviderSource());
			const resourceLoader = new DefaultResourceLoader({
				cwd: tempDir,
				agentDir,
				settingsManager,
				extensionFactories: [(pi) => {
					pi.on("model_catalog_discover", () => {
						order.push("discovery");
						pi.registerProvider("cursor", {
							baseUrl: "https://api2.cursor.sh",
							apiKey: "cursor-test-key",
							api: "cursor-agent",
							models: [{
								id: exactId, name: "Exact Cursor Route", reasoning: false, input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200_000, maxTokens: 64_000,
								compat: { cursorRouting: { [exactId]: { modelId: exactId, maxMode: false, supportsImages: false, catalogOccurrence: 0 } } },
							}],
						});
					});
				}],
			});
			await resourceLoader.reload({ deferExtensions: true, deferResources: true });
			const { session, modelFallbackMessage } = await createAgentSession({
				cwd: tempDir, agentDir, authStorage, modelRegistry, settingsManager, sessionManager, resourceLoader,
			});
			try {
				expect(session.model?.provider).not.toBe("cursor");
				expect(session.model?.id).not.toBe(exactId);
				expect(modelFallbackMessage).toContain(`cursor/${exactId}`);
				const showWarning = vi.fn();
				const retryMode = { options: { modelFallbackMessage }, session, sessionManager, settingsManager, showWarning };
				const harness: PromptTurnHarness = {
					deferredStartupPending: true,
					deferredStartupPromise: undefined,
					deferLoadedResourcesDisclosureUntilAgentEnd: false,
					pendingLoadedResourcesDisclosure: false,
					session: {
						get isStreaming() { return session.isStreaming; },
						prompt: vi.fn(async () => {
							order.push("prompt");
							expect(session.model?.provider).toBe("cursor");
							expect(session.model?.id).toBe(exactId);
						}),
					},
					showWorkingLoaderNow: vi.fn(() => order.push("spinner")),
					ensureDeferredStartupComplete: vi.fn(async () => {
						order.push("reload");
						await session.bindExtensions({ commandContextActions: createCommandActions() });
						await session.reload({ reason: "startup" });
						await InteractiveMode.prototype.retryDeferredModelRestore.call(retryMode as never);
						harness.deferredStartupPending = false;
					}),
					showLoadedResources: vi.fn(),
					maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
					discardDeferredRenderedUserInput: vi.fn(),
					showError: vi.fn(),
					stopWorkingLoader: vi.fn(),
					startupNoticesContainer: {},
				};

				await interactiveModePrototype.runUserPromptTurn.call(harness, "use exact default");

				expect(order).toEqual(["spinner", "reload", "discovery", "prompt"]);
				expect(showWarning).not.toHaveBeenCalled();
				expect(harness.showError).not.toHaveBeenCalled();
			} finally {
				session.dispose();
			}
		},
	);

	it("never prompts with a default model after real deferred Cursor scope resolution fails", async () => {
		const prompt = vi.fn(async () => {});
		const showError = vi.fn();
		const discoverExtensionModels = vi.fn(async () => {});
		const setScopedModels = vi.fn();
		const setModel = vi.fn();
		const defaultModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const scopeMode = {
			options: { deferredModelScopePatterns: ["cursor/missing-route"] },
			session: {
				discoverExtensionModels,
				modelRegistry: {
					getAvailable: vi.fn(async () => [defaultModel]),
					find: vi.fn(() => defaultModel),
					hasConfiguredAuth: vi.fn(() => true),
				},
				setScopedModels,
				setModel,
			},
			sessionManager: { buildSessionContext: () => ({ messages: [] }) },
			settingsManager: { getDefaultProvider: () => "anthropic", getDefaultModel: () => defaultModel.id },
			showError,
			showWarning: vi.fn(),
		};
		const harness: PromptTurnHarness = {
			deferredStartupPending: true,
			deferredStartupPromise: undefined,
			deferLoadedResourcesDisclosureUntilAgentEnd: false,
			pendingLoadedResourcesDisclosure: false,
			session: { isStreaming: false, prompt },
			showWorkingLoaderNow: vi.fn(),
			ensureDeferredStartupComplete: vi.fn(async () => applyDeferredModelScope(scopeMode as never)),
			showLoadedResources: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
			discardDeferredRenderedUserInput: vi.fn(),
			showError,
			stopWorkingLoader: vi.fn(),
			startupNoticesContainer: {},
		};

		await interactiveModePrototype.runUserPromptTurn.call(harness, "must not dispatch");

		expect(discoverExtensionModels).toHaveBeenCalledOnce();
		expect(setScopedModels).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(expect.stringMatching(/cursor\/missing-route.*reselect/s));
		expect(harness.discardDeferredRenderedUserInput).toHaveBeenCalledWith("must not dispatch");
	});
});
