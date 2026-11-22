import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@bastani/atomic-ai";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	createUnstartedAgentSessionFromServices,
	prepareAgentSessionServices,
} from "../src/core/agent-session-services.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("ModelRuntime startup refresh and availability deduplication", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-mr-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"local-loop": {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [
							{
								id: "loop-model",
								name: "loop-model",
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
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("runs ModelRuntime.refresh once across prepareAgentSessionServices and createUnstartedAgentSessionFromServices", async () => {
		const refreshSpy = vi.spyOn(ModelRuntime.prototype, "refresh");
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "local-loop",
			defaultModel: "loop-model",
		});
		const completeServices = await prepareAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const services = await completeServices();
		const { session } = await createUnstartedAgentSessionFromServices(
			{
				services,
				sessionManager: SessionManager.inMemory(tempDir),
				builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
			},
			false,
			false,
		);
		try {
			assert.equal(refreshSpy.mock.calls.length, 1);
			assert.equal(session.model?.provider, "local-loop");
			assert.equal(session.model?.id, "loop-model");
			assert.equal(services.modelRuntime.hasConfiguredAuth("local-loop"), true);
		} finally {
			await session.dispose();
		}
	});

	it("checks provider auth once per unauthenticated provider during availability refresh and keeps filterModels intact", async () => {
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		let unauthChecks = 0;
		let filterCalls = 0;
		const modelA: Model<"openai-completions"> = {
			id: "kept-model",
			name: "kept-model",
			api: "openai-completions",
			provider: "filtered-provider",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const modelB: Model<"openai-completions"> = { ...modelA, id: "dropped-model", name: "dropped-model" };
		const unauthProvider: Provider<"openai-completions"> = {
			id: "counting-unauth",
			name: "Counting Unauth",
			auth: {
				apiKey: {
					label: "Key",
					async resolve() {
						unauthChecks += 1;
						return undefined;
					},
				},
			},
			getModels: () => [{ ...modelA, provider: "counting-unauth", id: "u1", name: "u1" }],
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const filteredProvider: Provider<"openai-completions"> = {
			id: "filtered-provider",
			name: "Filtered",
			auth: {
				apiKey: {
					label: "Key",
					async resolve() {
						return { source: "env", auth: { apiKey: "ok" } };
					},
				},
			},
			getModels: () => [modelA, modelB],
			filterModels: (models) => {
				filterCalls += 1;
				return models.filter((m) => m.id === "kept-model");
			},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		runtime.registerNativeProvider(unauthProvider);
		runtime.registerNativeProvider(filteredProvider);
		await runtime.whenRegistrationRefreshesSettled();

		unauthChecks = 0;
		filterCalls = 0;
		await runtime.refresh({ allowNetwork: false });

		assert.equal(unauthChecks, 1, "unauthenticated provider auth should be checked once, not twice");
		assert.ok(filterCalls >= 1, "authenticated provider with filterModels must still filter available models");
		const availIds = runtime
			.getAvailableSnapshot()
			.filter((m) => m.provider === "filtered-provider")
			.map((m) => m.id);
		assert.deepEqual(availIds, ["kept-model"]);
	});

	it("still refreshes an externally supplied modelRuntime, a mutated runtime, a second session, and recoverMissingModel", async () => {
		// 1. External modelRuntime passed directly to createAgentSession picks up models.json edits.
		const externalRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"local-loop": {
						baseUrl: "http://127.0.0.1:2/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [
							{
								id: "updated-model",
								name: "updated-model",
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
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			builtinPackagePaths: [],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const externalSession = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRuntime: externalRuntime,
			resourceLoader: loader,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(tempDir),
			model: externalRuntime.getModel("local-loop", "loop-model"),
			builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
		});
		try {
			assert.ok(externalRuntime.getModel("local-loop", "updated-model"));
		} finally {
			await externalSession.session.dispose();
		}

		// 2. Mutation between completeServices and createUnstartedAgentSessionFromServices invalidates one-shot skip.
		const refreshSpy = vi.spyOn(ModelRuntime.prototype, "refresh");
		const completeServices = await prepareAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ defaultProvider: "local-loop", defaultModel: "updated-model" }),
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const services = await completeServices();
		assert.equal(refreshSpy.mock.calls.length, 1);

		// Mutate runtime via runtime API key -> must NOT skip sdk.ts restore.
		await services.modelRuntime.setRuntimeApiKey("local-loop", "override-key", {});
		const mutated = await createUnstartedAgentSessionFromServices(
			{
				services,
				sessionManager: SessionManager.inMemory(tempDir),
				builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
			},
			false,
			false,
		);
		try {
			// setRuntimeApiKey itself refreshes, plus sdk.ts must NOT skip its restore.
			assert.ok(refreshSpy.mock.calls.length >= 2);
		} finally {
			await mutated.session.dispose();
		}

		// 2b. A second session reusing the same services must NOT reuse the consumed one-shot skip.
		refreshSpy.mockClear();
		const completeServicesOnce = await prepareAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ defaultProvider: "local-loop", defaultModel: "updated-model" }),
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const servicesOnce = await completeServicesOnce();
		assert.equal(refreshSpy.mock.calls.length, 1);
		const firstSess = await createUnstartedAgentSessionFromServices(
			{
				services: servicesOnce,
				sessionManager: SessionManager.inMemory(tempDir),
				builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
			},
			false,
			false,
		);
		try {
			assert.equal(refreshSpy.mock.calls.length, 1);
			const secondSess = await createUnstartedAgentSessionFromServices(
				{
					services: servicesOnce,
					sessionManager: SessionManager.inMemory(tempDir),
					builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
				},
				false,
				false,
			);
			try {
				assert.equal(refreshSpy.mock.calls.length, 2);
			} finally {
				await secondSess.session.dispose();
			}
		} finally {
			await firstSess.session.dispose();
		}

		// 3. recoverMissingModel=true must NOT skip sdk.ts restore (preserves #5714 observing pass).
		refreshSpy.mockClear();
		const completeServices2 = await prepareAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({ defaultProvider: "local-loop", defaultModel: "updated-model" }),
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const services2 = await completeServices2();
		assert.equal(refreshSpy.mock.calls.length, 1);
		const observingSession = await createUnstartedAgentSessionFromServices(
			{
				services: services2,
				sessionManager: SessionManager.inMemory(tempDir),
				builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
			},
			false,
			true,
		);
		try {
			assert.equal(refreshSpy.mock.calls.length, 2);
		} finally {
			await observingSession.session.dispose();
		}
	});

	it("preserves corrupt models.json error reporting with single refresh", async () => {
		writeFileSync(join(agentDir, "models.json"), "{invalid json");
		const completeServices = await prepareAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
			resourceLoaderReloadOptions: { deferExtensions: true, deferResources: true },
		});
		const services = await completeServices();
		assert.ok(services.modelRuntime.getError(), "corrupt models.json error must be reported");
	});
});
