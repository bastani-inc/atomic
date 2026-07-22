import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import type { ProviderConfigInput } from "../../packages/coding-agent/src/core/model-registry-types.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../packages/coding-agent/src/core/agent-session-services.js";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import { prepareExplicitCliModel, resolveCliModel } from "../../packages/coding-agent/src/core/model-resolver-cli.js";
import { registerPendingProvidersAndPrepare } from "../../packages/coding-agent/src/core/provider-preparation-lifecycle.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.js";
import { CursorError } from "../../packages/cursor/src/errors.js";
import { registerCursorProvider, type CursorProviderRuntime } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const preparedModel: NonNullable<ProviderConfigInput["models"]>[number] = {
	id: "live",
	name: "Live",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

function requiredConfig(refreshModels: NonNullable<ProviderConfigInput["refreshModels"]>): ProviderConfigInput {
	return {
		name: "Required",
		baseUrl: "https://example.invalid",
		api: "openai-completions",
		apiKey: "test-only",
		models: [],
		requiresPreparation: true,
		refreshModels,
	};
}

async function createPreparedCursorStartupHarness() {
	const root = mkdtempSync(join(tmpdir(), "atomic-cursor-explicit-startup-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	let cursorRuntime: CursorProviderRuntime | undefined;
	try {
		const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
		const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "https://authentication.cursor.sh", sub: "auth0|startup" })}.signature`;
		const auth = AuthStorage.inMemory({
			cursor: { type: "oauth", access: token, refresh: token, expires: Date.now() + 60_000 },
		});
		const transport = new CursorMockTransport({
			messages: [{ type: "textDelta", text: "startup-ok" }, { type: "done", reason: "stop" }],
		});
		let discoveries = 0;
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: auth,
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				extensionFactories: [(pi) => {
					cursorRuntime = registerCursorProvider({
						registerProvider: (name, config) => pi.registerProvider(name, {
							...config,
							models: [...config.models],
							refreshModels: async (context) => [...await config.refreshModels(context)],
						}),
						on: () => undefined,
					}, {
						transport,
						discoveryService: {
							async discover() {
								discoveries += 1;
								return { fetchedAt: Date.now(), rows: [{ modelId: "cursor-grok-4.5-high", maxMode: false }] };
							},
						},
						catalogCache: { load: () => null, save: () => undefined },
						clientVersion: () => "startup-client-v1",
						uuid: () => "startup-request",
					});
				}],
			},
		});
		const runtime = cursorRuntime;
		assert.ok(runtime);
		await prepareExplicitCliModel({
			cliProvider: "cursor",
			cliModel: "cursor-grok-4.5-high",
			modelRegistry: services.modelRegistry,
		});
		const resolved = resolveCliModel({
			cliProvider: "cursor",
			cliModel: "cursor-grok-4.5-high",
			modelRegistry: services.modelRegistry,
		});
		assert.equal(resolved.error, undefined);
		assert.ok(resolved.model);
		return {
			agentDir,
			cwd,
			discoveries: () => discoveries,
			model: resolved.model,
			services,
			transport,
			cleanup: async () => {
				await runtime.dispose();
				rmSync(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await cursorRuntime?.dispose();
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

describe("required provider SDK preparation doors", () => {
	test("SDK explicitly prepares a supplied exact-provider model", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-required-sdk-explicit-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const auth = AuthStorage.inMemory();
			const registry = ModelRegistry.create(auth, []);
			let calls = 0;
			registry.registerProvider("cursor", {
				...requiredConfig(async () => { calls += 1; throw new CursorError("AuthenticationMissing", "Cursor host OAuth is required.", { operation: "authentication" }); }),
				models: [preparedModel], requiresHostOAuth: true, requiresExactSelectionPersistence: true,
			});
			const selected = registry.resolveExactModel("cursor", "live");
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
			await loader.reload();
			await assert.rejects(createAgentSession({
				cwd, agentDir, authStorage: auth, modelRegistry: registry, model: selected,
				settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
			}), (error: Error) => error instanceof CursorError && error.code === "AuthenticationMissing");
			assert.equal(calls, 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("SDK explicitly prepares saved exact defaults and session selections", async () => {
		const selection = { version: 1, provider: "cursor", accountScope: "cursor-account-v1:saved", routeId: "live", maxMode: "false", occurrence: 1 };
		for (const source of ["default", "session"] as const) {
			const root = mkdtempSync(join(tmpdir(), `atomic-required-sdk-${source}-`));
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			try {
				const auth = AuthStorage.inMemory();
				const registry = ModelRegistry.create(auth, []);
				let calls = 0;
				registry.registerProvider("cursor", {
					...requiredConfig(async () => { calls += 1; throw new CursorError("AuthenticationMissing", "Cursor host OAuth is required.", { operation: "authentication" }); }),
					requiresHostOAuth: true, requiresExactSelectionPersistence: true,
				});
				const settings = SettingsManager.inMemory();
				const session = SessionManager.inMemory(cwd);
				if (source === "default") settings.setDefaultModelAndProvider("cursor", "live", selection);
				else {
					session.appendModelChange("cursor", "live", selection);
					session.appendMessage({ role: "user", content: "resume", timestamp: 1 });
				}
				const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
				await loader.reload();
				await assert.rejects(createAgentSession({
					cwd, agentDir, authStorage: auth, modelRegistry: registry,
					settingsManager: settings, sessionManager: session, resourceLoader: loader,
				}), (error: Error) => error instanceof CursorError && error.code === "AuthenticationMissing");
				assert.equal(calls, 1);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test("SDK session reuses the service-prepared registered generation without clearing or duplication", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-required-sdk-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const auth = AuthStorage.inMemory();
			const registry = ModelRegistry.create(auth, []);
			let calls = 0;
			registry.registerProvider("required", requiredConfig(async () => { calls += 1; return [preparedModel]; }));
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
			await loader.reload();
			await registerPendingProvidersAndPrepare(loader, registry, true);
			const selected = registry.resolveExactModel("required", "live");
			const created = await createAgentSession({
				cwd, agentDir, authStorage: auth, modelRegistry: registry, model: selected,
				settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
			});
			assert.equal(calls, 1);
			assert.equal(registry.resolveExactModel("required", "live").id, selected.id);
			created.session.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("direct SDK session prepares an unprepared registered provider exactly once", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-required-sdk-direct-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const auth = AuthStorage.inMemory();
			const registry = ModelRegistry.create(auth, []);
			let calls = 0;
			registry.registerProvider("required", requiredConfig(async () => { calls += 1; return [preparedModel]; }));
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
			await loader.reload();
			const created = await createAgentSession({
				cwd, agentDir, authStorage: auth, modelRegistry: registry,
				settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
			});
			assert.equal(calls, 1);
			assert.equal(created.session.model?.id, "live");
			created.session.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("SDK preserves the ordinary provider offline refresh without touching required generations", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-ordinary-sdk-refresh-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const auth = AuthStorage.inMemory();
			const registry = ModelRegistry.create(auth, []);
			let calls = 0;
			registry.registerProvider("ordinary", {
				...requiredConfig(async ({ allowNetwork }) => {
					calls += 1;
					assert.equal(allowNetwork, false);
					return [{ ...preparedModel, id: "dynamic" }];
				}),
				requiresPreparation: false,
			});
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
			await loader.reload();
			const created = await createAgentSession({
				cwd, agentDir, authStorage: auth, modelRegistry: registry,
				settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
			});
			assert.equal(calls, 1);
			assert.equal(created.session.model?.id, "dynamic");
			created.session.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("service-backed sessions refresh ordinary providers after late runtime authentication", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-ordinary-services-refresh-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const auth = AuthStorage.inMemory();
			const observedKeys: Array<string | undefined> = [];
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage: auth,
				resourceLoaderOptions: {
					builtinPackagePaths: [],
					extensionFactories: [(pi) => pi.registerProvider("ordinary-late-auth", {
						name: "Ordinary late auth",
						baseUrl: "https://example.invalid",
						api: "openai-completions",
						apiKey: "$ATOMIC_LATE_KEY_TEST",
						models: [preparedModel],
						refreshModels: async ({ credential }) => {
							observedKeys.push(credential?.type === "api_key" ? credential.key : undefined);
							return [preparedModel];
						},
					})],
				},
			});
			auth.setRuntimeApiKey("ordinary-late-auth", "late-key");
			const selected = services.modelRegistry.resolveExactModel("ordinary-late-auth", "live");
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd),
				model: selected,
			});

			assert.deepEqual(observedKeys, ["late-key"]);
			assert.equal(created.session.model?.provider, "ordinary-late-auth");
			created.session.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("explicit Cursor startup prompts immediately on the prepared service-backed route", async () => {
		const harness = await createPreparedCursorStartupHarness();
		try {
			const created = await createAgentSessionFromServices({
				services: harness.services,
				sessionManager: SessionManager.inMemory(harness.cwd),
				model: harness.model,
			});
			assert.equal(harness.discoveries(), 1);
			assert.equal(created.session.model?.provider, "cursor");
			assert.equal(created.session.model?.id, "cursor-grok-4.5-high");

			await created.session.prompt("Reply with startup-ok");

			const response = created.session.messages.at(-1);
			assert.equal(response?.role, "assistant");
			if (response?.role === "assistant") {
				assert.equal(response.stopReason, "stop", response.errorMessage);
				assert.deepEqual(response.content.filter((part) => part.type === "text").map((part) => part.text), ["startup-ok"]);
			}
			assert.equal(harness.transport.runs.length, 1);
			assert.equal(harness.transport.runs[0]?.request.model.provider, "cursor");
			assert.equal(harness.transport.runs[0]?.request.model.id, "cursor-grok-4.5-high");
			assert.equal(harness.transport.runs[0]?.request.routeReference.routeId, "cursor-grok-4.5-high");
			created.session.dispose();
		} finally {
			await harness.cleanup();
		}
	});

	test("RPC refresh rebinds an explicit Cursor session to the refreshed exact route", async () => {
		const harness = await createPreparedCursorStartupHarness();
		try {
			const created = await createAgentSessionFromServices({
				services: harness.services,
				sessionManager: SessionManager.inMemory(harness.cwd),
				model: harness.model,
			});
			const handleRpc = createRpcCommandHandler({
				runtimeHost: { services: { agentDir: harness.agentDir } } as AgentSessionRuntime,
				getSession: () => created.session,
				rebindSession: async () => undefined,
				output: () => undefined,
			});

			const refreshResponse = await handleRpc({ type: "refresh_models", allowNetwork: true });

			assert.equal(refreshResponse?.success, true);
			assert.equal(harness.discoveries(), 2);
			assert.notEqual(created.session.model, harness.model);
			assert.equal(created.session.model?.provider, "cursor");
			assert.equal(created.session.model?.id, "cursor-grok-4.5-high");
			await created.session.prompt("Reply with startup-ok");
			const response = created.session.messages.at(-1);
			assert.equal(response?.role, "assistant");
			if (response?.role === "assistant") assert.equal(response.stopReason, "stop", response.errorMessage);
			assert.equal(harness.transport.runs.length, 1);
			assert.equal(harness.transport.runs[0]?.request.model.provider, "cursor");
			assert.equal(harness.transport.runs[0]?.request.model.id, "cursor-grok-4.5-high");
			assert.equal(harness.transport.runs[0]?.request.routeReference.routeId, "cursor-grok-4.5-high");
			created.session.dispose();
		} finally {
			await harness.cleanup();
		}
	});
});
