import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.ts";
import { createAuthInteraction } from "../../packages/coding-agent/src/core/oauth-login.ts";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import {
	type AgentSettledEvent,
	AuthStorage,
	type BeforeProviderHeadersEvent,
	buildContextEntries,
	CustomEntryComponent,
	createAgentSession,
	type EntryRenderer,
	type ExtensionAPI,
	type InlineExtension,
	ModelRegistry,
	ModelRuntime,
	readStoredCredential,
	sessionEntryToContextMessages,
} from "../../packages/coding-agent/src/index.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../packages/coding-agent/src/utils/ansi.ts";

void (undefined as AgentSettledEvent | BeforeProviderHeadersEvent | EntryRenderer | InlineExtension | undefined);

test("before_provider_headers handlers mutate headers sequentially and report errors", async () => {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		(api) => {
			api.on("before_provider_headers", (event) => {
				event.headers["x-first"] = "one";
			});
			api.on("before_provider_headers", (event) => {
				event.headers["x-second"] = `${event.headers["x-first"]}-two`;
			});
			api.on("before_provider_headers", () => {
				throw new Error("header failure");
			});
		},
		process.cwd(),
		createEventBus(),
		runtime,
	);
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		process.cwd(),
		SessionManager.inMemory(),
		new ModelRegistry(modelRuntime),
	);
	const errors: string[] = [];
	runner.onError((error) => errors.push(error.error));

	const headers = await runner.emitBeforeProviderHeaders({ existing: "yes" });
	assert.deepEqual(headers, { existing: "yes", "x-first": "one", "x-second": "one-two" });
	assert.deepEqual(errors, ["header failure"]);
});

test("entry renderer registration is discoverable", async () => {
	const runtime = createExtensionRuntime();
	const renderer: EntryRenderer = () => new Text("entry", 0, 0);
	const extension = await loadExtensionFromFactory(
		(api) => api.registerEntryRenderer("state", renderer),
		process.cwd(),
		createEventBus(),
		runtime,
	);
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		process.cwd(),
		SessionManager.inMemory(),
		new ModelRegistry(modelRuntime),
	);
	assert.equal(runner.getEntryRenderer("state"), renderer);
	assert.equal(runner.getEntryRenderer("missing"), undefined);
});

test("CustomEntryComponent renders, suppresses empty output, propagates expansion, and boxes failures", () => {
	initTheme("dark");
	const entry = {
		type: "custom",
		id: "e",
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "state",
		data: 1,
	} as const;
	const expanded: boolean[] = [];
	const component = new CustomEntryComponent(entry, (_entry, options) => {
		expanded.push(options.expanded);
		return new Text(options.expanded ? "expanded" : "collapsed", 0, 0);
	});
	assert.equal(component.hasContent(), true);
	component.setExpanded(true);
	assert.deepEqual(expanded, [false, true]);
	assert.match(stripAnsi(component.render(80).join("\n")), /expanded/);

	const suppressed = new CustomEntryComponent(entry, () => undefined);
	assert.equal(suppressed.hasContent(), false);
	assert.deepEqual(suppressed.render(80), []);

	const failed = new CustomEntryComponent(entry, () => {
		throw new Error("broken renderer");
	});
	assert.match(stripAnsi(failed.render(80).join("\n")), /\[state\] renderer failed: broken renderer/);
});

test("native provider registration round-trips through ModelRegistry and ModelRuntime", async () => {
	const runtime = await ModelRuntime.create({ modelsPath: null });
	const registry = new ModelRegistry(runtime);
	const builtin = registry.getProvider("anthropic");
	assert.ok(builtin);
	const provider = { ...builtin, id: "native-test", name: "Native Test" };
	registry.registerProvider(provider);
	assert.equal(registry.getProvider("native-test"), provider);

	assert.equal(runtime.getProvider("native-test"), provider);
	assert.ok(runtime.getProviders().some((candidate) => candidate.id === "native-test"));
	assert.equal(await runtime.checkAuth("native-test"), undefined);

	registry.unregisterProvider("native-test");
	assert.equal(registry.getProvider("native-test"), undefined);
});

test("ModelRuntime delegates enumeration, runtime auth, snapshots, and refresh", async () => {
	const auth = AuthStorage.inMemory();
	const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: null });
	const model = runtime.getModels("anthropic")[0];
	assert.ok(model);
	await runtime.setRuntimeApiKey("anthropic", "runtime-secret", {});
	assert.ok((await runtime.getAvailable("anthropic")).some((candidate) => candidate.id === model.id));
	const resolved = await runtime.getAuth(model);
	assert.equal(resolved?.auth.apiKey, "runtime-secret");
	assert.ok(runtime.getAvailableSnapshot().length > 0);
	await runtime.removeRuntimeApiKey("anthropic");
});

test("ModelRuntime delegates provider login and logout", async () => {
	const auth = AuthStorage.inMemory();
	const previousOffline = process.env.ATOMIC_OFFLINE;
	process.env.ATOMIC_OFFLINE = "1";
	const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: null });
	if (previousOffline === undefined) delete process.env.ATOMIC_OFFLINE;
	else process.env.ATOMIC_OFFLINE = previousOffline;
	const interaction = createAuthInteraction({
		onAuth() {},
		onDeviceCode() {},
		onProgress() {},
		async onPrompt() {
			return "sk-test";
		},
		async onSelect() {
			return "";
		},
	});
	assert.deepEqual(await runtime.login("anthropic", "api_key", interaction), { type: "api_key", key: "sk-test" });
	assert.deepEqual(await auth.read("anthropic"), { type: "api_key", key: "sk-test" });
	await runtime.logout("anthropic");
	assert.equal(await auth.read("anthropic"), undefined);
});

test("session context helpers preserve custom-message and compaction semantics", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	manager.appendCustomEntry("state", { count: 1 });
	const entries = manager.getEntries();
	assert.deepEqual(
		buildContextEntries(entries).map((entry) => entry.type),
		["message", "custom"],
	);
	assert.equal(sessionEntryToContextMessages(entries[0]).length, 1);
	assert.equal(sessionEntryToContextMessages(entries[1]).length, 0);
});

test("readStoredCredential reads a single credential from an explicit Atomic auth path", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-auth-"));
	const path = join(dir, "auth.json");
	try {
		const storage = AuthStorage.create(path);
		await storage.modify("example", async () => ({ type: "api_key", key: "secret" }));
		assert.deepEqual(readStoredCredential("example", path), { type: "api_key", key: "secret" });
		assert.equal(readStoredCredential("missing", path), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readStoredCredential returns undefined for malformed auth.json", () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-auth-malformed-"));
	const path = join(dir, "auth.json");
	try {
		writeFileSync(path, "{not valid json", "utf8");
		assert.equal(readStoredCredential("example", path), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("entry_appended is emitted and agent_settled follows agent_end", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-group4-session-"));
	const provider = "group4-fixture";
	const model: Model<"anthropic-messages"> = {
		id: "fixture-model",
		name: "Fixture",
		api: "anthropic-messages",
		provider,
		baseUrl: "https://fixture.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
	let extensionApi: ExtensionAPI | undefined;
	const observed: string[] = [];
	const streamSimple = (): ReturnType<typeof createAssistantMessageEventStream> => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: model.api,
				provider,
				model: model.id,
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	const inline: InlineExtension = {
		name: "group4-test",
		factory: (api) => {
			extensionApi = api;
			api.registerProvider(provider, {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "fixture-key",
				models: [model],
				streamSimple,
			});
		},
	};
	try {
		const settings = SettingsManager.inMemory({});
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: settings,
			extensionFactories: [inline],
			builtinPackagePaths: [],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const auth = AuthStorage.inMemory();
		const modelRuntime = await ModelRuntime.create({ credentials: auth, modelsPath: null });
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			settingsManager: settings,
			resourceLoader: loader,
			modelRuntime,
			sessionManager: SessionManager.inMemory(dir),
			model,
			noTools: "all",
		});
		session.subscribe((event) => observed.push(event.type));
		assert.ok(extensionApi);
		extensionApi.appendEntry("state", { ready: true });
		assert.equal(observed.at(-1), "entry_appended");
		await session.prompt("hello");
		assert.ok(observed.indexOf("agent_end") >= 0);
		assert.ok(observed.indexOf("agent_settled") > observed.indexOf("agent_end"));
		session.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
