import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import {
	AuthStorage,
	COMPACTED_OUTPUT_MAX_TOKENS,
	CompactionCancelledError,
	CompactionConfigError,
	CompactionError,
	CompactionStateError,
	CompactorFailure,
	type CompactorModel,
	compactedOutputTokenCap,
	createAgentSession,
	DefaultResourceLoader,
	findCompactionError,
	isCompactionCancelledError,
	isCompactionConfigError,
	isCompactionError,
	isCompactionStateError,
	isCompactorFailure,
	isRetryableCompactionError,
	type ProviderCompactorModelConfig,
	parseSerializedCompactionError,
	rehydrateCompactionError,
	requestCompactorOutput,
	SessionManager,
	SettingsManager,
	serializeCompactionError,
} from "../../packages/coding-agent/src/index.js";
import { buildSettingsItems } from "../../packages/coding-agent/src/modes/interactive/components/settings-selector-items.js";
import type {
	SettingsCallbacks,
	SettingsConfig,
} from "../../packages/coding-agent/src/modes/interactive/components/settings-selector-types.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { RemoteModelCatalog } from "../../packages/coding-agent/src/modes/interactive-engine/remote-model-catalog.js";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.js";
import { assertRpcSuccess } from "../../packages/coding-agent/src/modes/rpc/rpc-error-decoding.js";
import { createRpcModelCatalog } from "../../packages/coding-agent/src/modes/rpc/rpc-model-catalog.js";
import { stripVTControlCharacters } from "../helpers/visible-text.js";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("custom remote compactor models", () => {
	test("models.json defines a custom compactor with custom API params, endpointPath, headers, timeoutMs, and maxTokens", async () => {
		const dir = tempDir("atomic-custom-compactor-");
		try {
			const modelsPath = join(dir, "models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						"acme-compact": {
							baseUrl: "https://compact.example.com/v2",
							apiKey: "sk-acme-secret-key",
							headers: { "X-Provider": "acme" },
							models: [
								{
									id: "compress-fast",
									name: "Acme Compress Fast",
									type: "compactor",
									api: "custom-compact",
									endpointPath: "/compress",
									compactionParams: {
										target_ratio: 0.35,
										preserve_recent: 2,
										mode: "aggressive",
									},
									timeoutMs: 45_000,
									maxTokens: 48_000,
									headers: { "X-Model": "v2" },
								},
							],
						},
					},
				}),
			);

			const auth = AuthStorage.inMemory();
			const runtime = await ModelRuntime.create({
				credentials: auth,
				modelsPath,
				allowModelNetwork: false,
			});
			const compactors = runtime.getModelsOfType("compactor");
			const custom = compactors.find((m) => m.provider === "acme-compact" && m.id === "compress-fast");
			assert.ok(custom, "custom compactor must be registered");
			assert.equal(custom.type, "compactor");
			assert.equal(custom.api, "custom-compact");
			assert.equal(custom.endpointPath, "/compress");
			assert.equal(custom.timeoutMs, 45_000);
			assert.equal(custom.maxTokens, 48_000);
			assert.deepEqual(custom.compactionParams, {
				target_ratio: 0.35,
				preserve_recent: 2,
				mode: "aggressive",
			});

			assert.equal(
				runtime.getAvailableSnapshot().some((m) => m.provider === "acme-compact"),
				false,
			);

			const resolved = await runtime.getAuth(custom);
			assert.equal(resolved?.auth.apiKey, "sk-acme-secret-key");
			assert.equal(resolved?.auth.headers?.["X-Provider"], "acme");
			assert.equal(resolved?.auth.headers?.["X-Model"], "v2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("models.json modelOverrides customizes built-in morph/morph-compactor parameters", async () => {
		const dir = tempDir("atomic-morph-override-");
		try {
			const modelsPath = join(dir, "models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						morph: {
							baseUrl: "https://morph-proxy.example.com/v1",
							modelOverrides: {
								"morph-compactor": {
									compactionParams: {
										compression_ratio: 0.25,
										preserve_recent: 3,
									},
									timeoutMs: 180_000,
									maxTokens: 50_000,
									headers: { "X-Morph-Tenant": "eng" },
								},
							},
						},
					},
				}),
			);

			const auth = AuthStorage.inMemory({ morph: { type: "api_key", key: "sk-morph-test" } });
			const runtime = await ModelRuntime.create({
				credentials: auth,
				modelsPath,
				allowModelNetwork: false,
			});
			const morph = runtime
				.getModelsOfType("compactor")
				.find((m) => m.provider === "morph" && m.id === "morph-compactor");
			assert.ok(morph);
			assert.equal(morph.baseUrl, "https://morph-proxy.example.com/v1");
			assert.deepEqual(morph.compactionParams, { compression_ratio: 0.25, preserve_recent: 3 });
			assert.equal(morph.timeoutMs, 180_000);
			assert.equal(morph.maxTokens, 50_000);

			const resolved = await runtime.getAuth(morph);
			assert.equal(resolved?.auth.headers?.["X-Morph-Tenant"], "eng");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("requestCompactorOutput sends only configured params plus messages, query, and model without injecting hard-coded Morph defaults", async () => {
		const captured: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
		const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			captured.push({
				url: String(input),
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			});
			return new Response(JSON.stringify({ output: "compacted result" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await requestCompactorOutput({
			apiKey: "sk-morph-123",
			api: "morph-compact",
			modelId: "morph-compactor",
			baseUrl: "https://api.morphllm.com/v1/",
			headers: { "X-Custom": "abc" },
			messages: [{ role: "user", content: "hi" }],
			query: "keep decisions",
			signal: new AbortController().signal,
			fetchFn: fakeFetch,
		});

		assert.equal(captured[0]!.url, "https://api.morphllm.com/v1/compact");
		assert.equal(captured[0]!.headers.Authorization, "Bearer sk-morph-123");
		assert.equal(captured[0]!.headers["X-Custom"], "abc");
		assert.deepEqual(captured[0]!.body, {
			messages: [{ role: "user", content: "hi" }],
			query: "keep decisions",
			model: "morph-compactor",
		});

		await requestCompactorOutput({
			apiKey: undefined,
			api: "custom-compact",
			modelId: "compress-v2",
			baseUrl: "https://compact.example.com/run",
			endpointPath: "",
			params: { target_tokens: 4000, compression_ratio: 0.4 },
			headers: { "X-API-Key": "secret-header-token" },
			messages: [{ role: "user", content: "hi" }],
			query: "focus",
			signal: new AbortController().signal,
			fetchFn: fakeFetch,
		});

		assert.equal(captured[1]!.url, "https://compact.example.com/run");
		assert.equal(captured[1]!.headers.Authorization, undefined);
		assert.equal(captured[1]!.headers["X-API-Key"], "secret-header-token");
		assert.deepEqual(captured[1]!.body, {
			target_tokens: 4000,
			compression_ratio: 0.4,
			messages: [{ role: "user", content: "hi" }],
			query: "focus",
			model: "compress-v2",
		});
	});

	test("custom compactors require an explicit api identifier while built-in morph defines morph-compact", async () => {
		const dir = tempDir("atomic-compactor-api-required-");
		try {
			const modelsPath = join(dir, "models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						"no-api-comp": {
							baseUrl: "https://compact.example.com/v1",
							apiKey: "sk-test",
							models: [{ id: "m1", type: "compactor" }],
						},
					},
				}),
			);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath,
				allowModelNetwork: false,
			});
			assert.equal(
				runtime.getModelsOfType("compactor").some((m) => m.provider === "no-api-comp"),
				false,
				"compactor model without api must not register with a default api",
			);
			const morph = runtime
				.getModelsOfType("compactor")
				.find((m) => m.provider === "morph" && m.id === "morph-compactor");
			assert.ok(morph);
			assert.equal(morph.api, "morph-compact");
			assert.equal(morph.baseUrl, "https://api.morphllm.com/v1");

			assert.throws(
				() =>
					runtime.registerProvider("ext-no-api", {
						baseUrl: "https://ext.example.com",
						apiKey: "sk-ext",
						models: [
							{
								id: "m1",
								name: "No API",
								type: "compactor",
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					}),
				/no "api" specified/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("CompactionError family supports typed codes, guards, serialization, rehydration, and RPC decoding", async () => {
		const missingUrlErr = await requestCompactorOutput({
			apiKey: "sk-test",
			modelId: "m1",
			baseUrl: "",
			messages: [],
			query: "q",
			signal: new AbortController().signal,
		}).catch((caught: unknown) => caught);
		assert.ok(missingUrlErr instanceof CompactorFailure);
		assert.ok(missingUrlErr instanceof CompactionError);
		assert.equal(missingUrlErr.code, "missing-base-url");
		assert.equal(missingUrlErr.retryable, false);

		const samples: CompactionError[] = [
			new CompactionConfigError({ source: "rpc", field: "compactionModel", scope: "global" }),
			new CompactionCancelledError({ reason: "extension" }),
			new CompactionStateError({ code: "nothing-to-compact" }),
			new CompactorFailure("HTTP 503: upstream busy", { code: "http-error", status: 503, model: "acme/c1" }),
			new CompactorFailure("timed out after 500 ms", { code: "timeout", timeoutMs: 500, model: "acme/c1" }),
		];
		for (const sample of samples) {
			const serialized = serializeCompactionError(sample);
			const parsed = parseSerializedCompactionError(serialized);
			assert.ok(parsed, `failed to parse ${sample.name}`);
			const restored = rehydrateCompactionError(parsed);
			assert.equal(restored.name, sample.name);
			assert.equal(restored.code, sample.code);
			assert.equal(restored.message, sample.message);
			assert.equal(restored.hint, sample.hint);
			assert.equal(restored.retryable, sample.retryable);
			assert.deepEqual(restored.fields(), sample.fields());
			assert.equal(isCompactionError(restored), true);
		}
		assert.equal(isCompactionConfigError(samples[0]), true);
		assert.equal(isCompactionCancelledError(samples[1]), true);
		assert.equal(isCompactionStateError(samples[2]), true);
		assert.equal(isCompactorFailure(samples[3]), true);
		assert.equal(isRetryableCompactionError(new Error("wrapped", { cause: samples[3] })), true);
		assert.equal(isRetryableCompactionError(samples[0]), false);
		assert.equal(findCompactionError(new Error("outer", { cause: samples[4] })), samples[4]);
	});

	test("requestCompactorOutput redacts custom auth header secrets in errors and output", async () => {
		const secret = "super-secret-header-value-999";
		const echoOutput = (async () =>
			new Response(JSON.stringify({ output: `summary leaked ${secret}` }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;

		const result = await requestCompactorOutput({
			apiKey: undefined,
			api: "custom-compact",
			modelId: "m1",
			baseUrl: "https://compact.example.com",
			headers: { "X-API-Key": secret },
			messages: [],
			query: "q",
			signal: new AbortController().signal,
			fetchFn: echoOutput,
		});
		assert.equal(result.text.includes(secret), false);
		assert.ok(result.text.includes("[redacted]"));

		const echoError = (async () => new Response(`invalid key ${secret}`, { status: 401 })) as unknown as typeof fetch;
		await assert.rejects(
			requestCompactorOutput({
				apiKey: undefined,
				api: "custom-compact",
				modelId: "m1",
				baseUrl: "https://compact.example.com",
				headers: { "X-API-Key": secret },
				messages: [],
				query: "q",
				signal: new AbortController().signal,
				fetchFn: echoError,
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal(error.message.includes(secret), false);
				return true;
			},
		);
	});

	test("compactedOutputTokenCap honors per-model maxTokens while staying capped at 50% of trigger budget", () => {
		assert.equal(compactedOutputTokenCap(200_000), COMPACTED_OUTPUT_MAX_TOKENS);
		assert.equal(compactedOutputTokenCap(200_000, 60_000), 60_000);
		assert.equal(compactedOutputTokenCap(40_000, 60_000), 20_000);
		assert.equal(compactedOutputTokenCap(200_000, 10_000), 10_000);
	});

	test("extension registerProvider registers custom compactor models and RPC/RemoteModelCatalog relays them", async () => {
		const dir = tempDir("atomic-ext-compactor-");
		try {
			const compactorDef: ProviderCompactorModelConfig = {
				id: "ext-compact",
				name: "Extension Compactor",
				type: "compactor",
				api: "custom-compact",
				endpointPath: "/v1/compact",
				compactionParams: { budget: 8000 },
				timeoutMs: 90_000,
				maxTokens: 24_000,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const loader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: dir,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(atomic) => {
						atomic.registerProvider("ext-comp", {
							baseUrl: "https://ext.example.com",
							apiKey: "sk-ext-key",
							models: [compactorDef],
						});
					},
				],
			});
			await loader.reload();

			const auth = AuthStorage.inMemory();
			const modelRuntime = await ModelRuntime.create({ credentials: auth, allowModelNetwork: false });
			const settings = SettingsManager.inMemory();
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRuntime,
				settingsManager: settings,
				sessionManager: SessionManager.inMemory(dir),
				resourceLoader: loader,
			});
			try {
				const compactors = session.modelRuntime.getModelsOfType("compactor");
				const found = compactors.find((m) => m.provider === "ext-comp" && m.id === "ext-compact");
				assert.ok(found, "extension compactor should be discovered on modelRuntime");
				assert.deepEqual(found.compactionParams, { budget: 8000 });
				assert.equal(found.maxTokens, 24_000);

				const rpcCatalog = createRpcModelCatalog(session);
				assert.ok(
					rpcCatalog.compactorModels?.some((m) => m.provider === "ext-comp" && m.id === "ext-compact"),
					"RpcModelCatalog must include extension compactor models",
				);

				const hostRuntime = await ModelRuntime.create({
					credentials: AuthStorage.inMemory(),
					allowModelNetwork: false,
				});
				const hostSession = { modelRuntime: hostRuntime, scopedModels: [] } as unknown as Parameters<
					RemoteModelCatalog["patch"]
				>[0];
				const remoteCatalog = new RemoteModelCatalog({} as never);
				remoteCatalog.apply(rpcCatalog);
				remoteCatalog.patch(hostSession);
				const hostCompactors = hostSession.modelRuntime.getModelsOfType("compactor");
				assert.ok(
					hostCompactors.some((m) => m.provider === "ext-comp" && m.id === "ext-compact"),
					"RemoteModelCatalog must expose engine compactor models to /settings",
				);
			} finally {
				await session.dispose();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("settings selector lists Automatic and auto-discovers custom compactors with authenticated models first", () => {
		initTheme("dark");
		const customModel: CompactorModel = {
			type: "compactor",
			api: "custom-compact",
			provider: "acme",
			id: "compact-v2",
			name: "Acme Compactor",
			baseUrl: "https://compact.example.com",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const morphModel: CompactorModel = {
			type: "compactor",
			api: "morph-compact",
			provider: "morph",
			id: "morph-compactor",
			name: "Morph Compactor",
			baseUrl: "https://api.morphllm.com/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const config = {
			autoCompact: true,
			showImages: true,
			imageWidthCells: 60,
			autoResizeImages: true,
			blockImages: false,
			enableSkillCommands: true,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			transport: "auto",
			httpIdleTimeoutMs: 600_000,
			cacheWarming: "idle",
			thinkingLevel: "off",
			availableThinkingLevels: ["off"],
			availableCompactorModels: [morphModel, customModel],
			compactorProviderAuth: { morph: false, acme: true },
			compactionModel: "auto",
			compactionModelScope: "global",
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["dark"],
			hideThinkingBlock: false,
			mermaidRenderingMode: "streaming",
			latexRenderingEnabled: true,
			collapseChangelog: false,
			debug: false,
			enableInstallTelemetry: true,
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			showHardwareCursor: false,
			fullscreenScrollbar: "auto",
			fullscreenExitOutput: "transcript",
			fullscreenCopyOnSelect: true,
			editorPaddingX: 0,
			outputPad: 1,
			showCacheMissNotices: false,
			autocompleteMaxVisible: 5,
			quietStartup: false,
			defaultProjectTrust: "ask",
			clearOnShrink: false,
			showTerminalProgress: false,
			warnings: { anthropicExtraUsage: true },
		} as SettingsConfig;
		const item = buildSettingsItems(config, {
			onCompactionModelChange: () => {},
		} as unknown as SettingsCallbacks).find((entry) => entry.id === "compaction-model");
		assert.ok(item);
		assert.equal(item.currentValue, "Automatic");
		const rendered = stripVTControlCharacters(
			item.submenu!("", () => {})
				.render(120)
				.join("\n"),
		);
		assert.ok(rendered.includes("Automatic"));
		assert.ok(rendered.includes("acme/compact-v2"));
		assert.ok(rendered.includes("morph/morph-compactor"));
		assert.ok(rendered.includes("requires /login morph"));
		assert.ok(!rendered.includes("requires /login acme"));
		assert.ok(rendered.indexOf("acme/compact-v2") < rendered.indexOf("morph/morph-compactor"));
	});

	test("compactionModel and decisionModel switch live via session and RPC without reloading, and failed compactors fall back to Automatic", async () => {
		const dir = tempDir("atomic-live-compaction-switch-");
		try {
			const loader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: dir,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(atomic) => {
						atomic.registerProvider("broken-comp", {
							baseUrl: "http://127.0.0.1:1",
							apiKey: "sk-broken-test",
							models: [
								{
									id: "failing-v1",
									name: "Failing Compactor",
									type: "compactor",
									api: "custom-compact",
									timeoutMs: 2_000,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								},
							],
						});
					},
				],
			});
			await loader.reload();

			const auth = AuthStorage.inMemory();
			const modelRuntime = await ModelRuntime.create({ credentials: auth, allowModelNetwork: false });
			const settings = SettingsManager.inMemory();
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRuntime,
				settingsManager: settings,
				sessionManager: SessionManager.inMemory(dir),
				resourceLoader: loader,
			});
			try {
				const handle = createRpcCommandHandler({
					runtimeHost: {} as never,
					getSession: () => session,
					rebindSession: async () => {},
					output: () => {},
				});
				const compactRes = await handle({
					id: "c1",
					type: "set_compaction_model",
					model: "broken-comp/failing-v1",
					scope: "global",
				});
				assert.equal(compactRes?.success, true);
				assert.equal(session.settingsManager.getCompactionModel(), "broken-comp/failing-v1");

				const decisionRes = await handle({
					id: "d1",
					type: "set_decision_model",
					model: "typesafe/jev-latest",
					scope: "global",
				});
				assert.equal(decisionRes?.success, true);
				assert.equal(session.settingsManager.getDecisionModel(), "typesafe/jev-latest");

				// Switching back to Automatic works immediately without reload
				session.setCompactionModel("");
				assert.equal(session.settingsManager.getCompactionModel(), "");
				session.setDecisionModel("");
				assert.equal(session.settingsManager.getDecisionModel(), "");

				session.setCompactionModel("broken-comp/failing-v1");
				const model = session.modelRuntime.getModelsOfType("chat")[0];
				assert.ok(model);
				session.agent.state.model = model;
				await session.sessionManager.appendMessage({
					role: "user",
					content: "Investigate compaction fallback",
					timestamp: Date.now(),
				});
				await session.sessionManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "Checked." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 100,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 120,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});

				const result = await session.compact({ query: "keep fallback check" });
				assert.equal(result.form, "cleared");
				assert.ok(result.fallbackReason?.includes("broken-comp/failing-v1 failed"));

				// Invalid RPC payloads return serialized CompactionConfigError and rehydrate cleanly
				const badScope = await handle({
					id: "c2",
					type: "set_compaction_model",
					model: "morph/morph-compactor",
					scope: "workspace" as never,
				});
				assert.ok(badScope && !badScope.success);
				assert.equal(badScope.errorCode, "compaction_error");
				assert.throws(
					() => assertRpcSuccess(badScope),
					(error: unknown) => {
						assert.ok(error instanceof CompactionConfigError);
						assert.ok(error instanceof CompactionError);
						assert.equal(error.code, "invalid-setting");
						assert.equal(error.field, "scope");
						return true;
					},
				);

				// persist: false updates live in-memory settings without modifying disk or masking project scope
				const inMemoryRes = await handle({
					id: "c3",
					type: "set_compaction_model",
					model: "morph/morph-compactor",
					scope: "global",
					persist: false,
				});
				assert.equal(inMemoryRes?.success, true);
				assert.equal(session.settingsManager.getCompactionModel(), "morph/morph-compactor");
			} finally {
				await session.dispose();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
