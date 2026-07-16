import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai/compat";
import { describe, expect, test, vi } from "vitest";
import { CursorModelDiscoveryService } from "../../../cursor/src/models.ts";
import type { CursorModelCatalog } from "../../../cursor/src/model-mapper.ts";
import { registerCursorProvider, type CursorProviderHost, type CursorProviderRuntime } from "../../../cursor/src/provider.ts";
import { workflowModelCatalogFromContext } from "../../../workflows/src/extension/extension-runtime-state.ts";
import { buildModelCandidatesFromCatalog } from "../../../workflows/src/runs/shared/model-fallback.ts";
import { dispatch } from "../../../workflows/src/extension/dispatcher.ts";
import { workflow } from "../../../workflows/src/authoring/workflow.ts";
import { createRegistry } from "../../../workflows/src/workflows/registry.ts";
import { createStore } from "../../../workflows/src/shared/store.ts";
import { createCancellationRegistry } from "../../../workflows/src/runs/background/cancellation-registry.ts";
import { createJobTracker } from "../../../workflows/src/runs/background/job-tracker.ts";
import type { WorkflowDefinition } from "../../../workflows/src/shared/types.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionAPI, ExtensionContextActions } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { CursorMockTransport } from "../../../../test/unit/cursor-test-helpers.ts";
import { registerTrustedCursorProvider, trustedCursorProviderSource } from "../cursor-test-provider-source.ts";

const extensionActions: ExtensionActions = {
	sendMessage() {}, sendUserMessage() {}, appendEntry() {}, setSessionName() {}, getSessionName: () => undefined,
	setLabel() {}, getActiveTools: () => [], getAllTools: () => [], setActiveTools() {}, refreshTools() {},
	getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel() {},
};
const contextActions: ExtensionContextActions = {
	getModel: () => undefined, isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined,
	abort() {}, hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined,
	compact() {}, getSystemPrompt: () => "",
};

function token(subject: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

class DeferredDiscovery extends CursorModelDiscoveryService {
	calls = 0;
	constructor(readonly result: Promise<CursorModelCatalog>) { super({ transport: new CursorMockTransport() }); }
	override async discover(): Promise<CursorModelCatalog> { this.calls += 1; return this.result; }
}

function cursorHost(pi: ExtensionAPI): CursorProviderHost {
	return {
		registerProvider(name, config) {
			pi.registerProvider(name, {
				...config,
				api: "cursor-agent",
				models: config.models.map((model) => ({ ...model, input: [...model.input], cost: { ...model.cost } })),
			});
		},
		on(event, handler) {
			const forward = (value: unknown, context: Parameters<typeof handler>[1]): Promise<void> => Promise.resolve(handler(value, context));
			switch (event) {
				case "model_catalog_discover": pi.on("model_catalog_discover", forward); break;
				case "session_start": pi.on("session_start", forward); break;
				case "session_before_switch": pi.on("session_before_switch", forward); break;
				case "session_before_fork": pi.on("session_before_fork", forward); break;
				case "session_before_tree": pi.on("session_before_tree", forward); break;
				case "session_shutdown": pi.on("session_shutdown", forward); break;
			}
		},
	};
}

interface RealContext {
	readonly runner: ExtensionRunner;
	readonly authStorage: AuthStorage;
	readonly registry: ModelRegistry;
	readonly discovery: DeferredDiscovery;
	readonly runtime: CursorProviderRuntime;
	readonly transport: CursorMockTransport;
}

async function setup(result: Promise<CursorModelCatalog>): Promise<RealContext> {
	const access = token("workflow-context-account");
	const authStorage = AuthStorage.inMemory();
	authStorage.set("cursor", { type: "oauth", access, refresh: "refresh", expires: Date.now() + 60_000 } satisfies OAuthCredentials & { type: "oauth" });
	const registry = ModelRegistry.inMemory(authStorage, trustedCursorProviderSource());
	registry.registerProvider("openai", {
		baseUrl: "https://example.invalid", apiKey: "test", api: "openai-responses",
		models: [{ id: "gpt-5-mini", name: "GPT", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100 }],
	});
	const discovery = new DeferredDiscovery(result);
	const transport = new CursorMockTransport();
	let runtime: CursorProviderRuntime | undefined;
	const loaded = await createTestExtensionsResult([(pi) => {
		runtime = registerCursorProvider(cursorHost(pi), {
			discoveryService: discovery,
			transport,
			catalogCache: { load: () => null, save() {}, clear() {} },
			onCatalogDiagnostic() {},
		});
	}]);
	for (const registration of loaded.runtime.pendingProviderRegistrations) registration.source = trustedCursorProviderSource();
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), SessionManager.inMemory(), registry);
	runner.bindCore(extensionActions, contextActions);
	runner.setUIContext(undefined, "tui");
	if (!runtime) throw new Error("Cursor test provider did not initialize");
	expect(await registry.getApiKeyForProvider("cursor")).toBe(access);
	return { runner, registry, discovery, runtime, transport, authStorage };
}

describe("real Cursor workflow discovery timing", () => {
	test("a runner with no catalog handlers exposes no strict Cursor discovery attestation", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set("cursor", { type: "api_key", key: "static-key" });
		const registry = ModelRegistry.inMemory(authStorage, trustedCursorProviderSource());
		const stale: Model<Api> = {
			id: "stale-listed-route", name: "Stale", provider: "cursor", api: "cursor-agent",
			baseUrl: "https://api2.cursor.sh", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100,
			compat: { cursorRouting: { "stale-listed-route": { modelId: "stale-listed-route", maxMode: false, supportsImages: false, catalogOccurrence: 0 } } },
		};
		registerTrustedCursorProvider(registry, { baseUrl: stale.baseUrl, apiKey: "static-key", api: "cursor-agent", models: [stale] });
		const loaded = await createTestExtensionsResult([]);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), SessionManager.inMemory(), registry);
		runner.bindCore(extensionActions, contextActions);
		runner.setUIContext(undefined, "tui");
		const context = runner.createContext();
		expect(context.discoverModelCatalog).toBeUndefined();
		const listed = vi.spyOn(registry, "getAvailable");
		const catalog = workflowModelCatalogFromContext(context);
		expect(catalog).toBeDefined();
		await expect(buildModelCandidatesFromCatalog({ primaryModel: "cursor/stale-listed-route", catalog })).rejects.toThrow(/authenticated Cursor model discovery is unavailable/u);
		expect(listed).not.toHaveBeenCalled();
	});

	test("immediate callers share TUI discovery and one cancellation detaches", async () => {
		let resolveCatalog: ((catalog: CursorModelCatalog) => void) | undefined;
		const state = await setup(new Promise((resolve) => { resolveCatalog = resolve; }));
		await state.runner.emit({ type: "session_start", reason: "startup" });
		const catalog = workflowModelCatalogFromContext(state.runner.createContext());
		expect(catalog).toBeDefined();
		if (!catalog) throw new Error("Missing workflow model catalog");
		const controller = new AbortController();
		const cancelled = buildModelCandidatesFromCatalog({ primaryModel: "cursor/live-route", catalog, signal: controller.signal });
		const survivor = buildModelCandidatesFromCatalog({ primaryModel: "cursor/live-route", catalog });
		const nonCursor = await buildModelCandidatesFromCatalog({ primaryModel: "openai/gpt-5-mini", catalog });
		expect(nonCursor[0]?.id).toBe("openai/gpt-5-mini");
		expect(state.discovery.calls).toBe(1);
		expect(state.transport.runs).toHaveLength(0);
		controller.abort(new Error("cancel one workflow"));
		await expect(cancelled).rejects.toThrow("cancel one workflow");
		resolveCatalog?.({ source: "live", fetchedAt: Date.now(), models: [{ id: "live-route", maxMode: false }] });
		const [candidate] = await survivor;
		expect(candidate?.id).toBe("cursor/live-route");
		expect(state.registry.find("cursor", "live-route")).toBeDefined();
		expect(state.discovery.calls).toBe(1);
		await state.runtime.dispose();
	});

	test("concurrent named Cursor dispatches await shared discovery before creating Runs", async () => {
		let resolveCatalog: ((catalog: CursorModelCatalog) => void) | undefined;
		const state = await setup(new Promise((resolve) => { resolveCatalog = resolve; }));
		await state.runner.emit({ type: "session_start", reason: "startup" });
		const models = workflowModelCatalogFromContext(state.runner.createContext());
		if (!models) throw new Error("Missing workflow model catalog");
		let bodyCalls = 0;
		const definition = workflow({ name: "named-cursor-discovery", description: "", inputs: {}, outputs: {}, run: async () => { bodyCalls += 1; return {}; } }) as WorkflowDefinition;
		const store = createStore();
		const options = { registry: createRegistry([definition]), store, cancellation: createCancellationRegistry(), jobs: createJobTracker(), models };
		const first = dispatch({ action: "run", workflow: definition.name, model: "cursor/live-route" }, options);
		const second = dispatch({ action: "run", workflow: definition.name, model: "cursor/live-route" }, options);
		await Promise.resolve();
		expect(state.discovery.calls).toBe(1);
		expect(store.runs()).toHaveLength(0);
		resolveCatalog?.({ source: "live", fetchedAt: Date.now(), models: [{ id: "live-route", maxMode: false }] });
		const results = await Promise.all([first, second]);
		expect(results.every((result) => result.action === "run" && result.runId.length > 0)).toBe(true);
		expect(state.discovery.calls).toBe(1);
		await Promise.all(results.flatMap((result) => result.action === "run" ? [options.jobs.get(result.runId)?.promise] : []).filter((promise): promise is Promise<void> => promise !== undefined));
		expect(bodyCalls).toBe(2);
		await state.runtime.dispose();
	});

	test("failed discovery rejects strict Cursor validation before Run", async () => {
		const state = await setup(Promise.reject(new Error("GetUsable failed")));
		await state.runner.emit({ type: "session_start", reason: "startup" });
		const models = workflowModelCatalogFromContext(state.runner.createContext());
		if (!models) throw new Error("Missing workflow model catalog");
		let bodyCalls = 0;
		const definition = workflow({ name: "named-cursor-failure", description: "", inputs: {}, outputs: {}, run: async () => { bodyCalls += 1; return {}; } }) as WorkflowDefinition;
		const store = createStore();
		const jobs = createJobTracker();
		const result = await dispatch(
			{ action: "run", workflow: definition.name, model: "cursor/live-route", fallbackModels: ["openai/gpt-5-mini"] },
			{ registry: createRegistry([definition]), store, jobs, cancellation: createCancellationRegistry(), models },
		);
		expect(result.action).toBe("run");
		if (result.action === "run") {
			expect(result.runId).toBe("");
			expect(result.error).toMatch(/cursor\/live-route.*reselect/s);
		}
		expect(bodyCalls).toBe(0);
		expect(store.runs()).toHaveLength(0);
		expect(jobs.runIds()).toHaveLength(0);
		expect(state.registry.find("cursor", "live-route")).toBeUndefined();
		expect(state.transport.runs).toHaveLength(0);
		await state.runtime.dispose();
	});

	test("logout invalidates the live catalog before named workflow Run creation", async () => {
		const state = await setup(Promise.resolve({
			source: "live",
			fetchedAt: Date.now(),
			models: [{ id: "logout-route", maxMode: false }],
		}));
		await state.runner.createContext().discoverModelCatalog?.();
		expect(state.registry.find("cursor", "logout-route")).toBeDefined();
		state.authStorage.remove("cursor");

		let bodyCalls = 0;
		const definition = workflow({
			name: "named-cursor-logout",
			description: "",
			inputs: {},
			outputs: {},
			run: async () => { bodyCalls += 1; return {}; },
		}) as WorkflowDefinition;
		const store = createStore();
		const jobs = createJobTracker();
		const models = workflowModelCatalogFromContext(state.runner.createContext());
		if (!models) throw new Error("Missing workflow model catalog");
		const result = await dispatch(
			{ action: "run", workflow: definition.name, model: "cursor/logout-route", fallbackModels: ["openai/gpt-5-mini"] },
			{ registry: createRegistry([definition]), store, jobs, cancellation: createCancellationRegistry(), models },
		);
		expect(result.action).toBe("run");
		if (result.action === "run") {
			expect(result.runId).toBe("");
			expect(result.error).toMatch(/cursor\/logout-route.*reselect/s);
		}
		expect(bodyCalls).toBe(0);
		expect(store.runs()).toHaveLength(0);
		expect(jobs.runIds()).toHaveLength(0);
		expect(state.registry.find("cursor", "logout-route")).toBeUndefined();
		expect(state.transport.runs).toHaveLength(0);
		await state.runtime.dispose();
	});
});
