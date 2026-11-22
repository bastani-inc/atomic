import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@bastani/atomic-ai";
import {
	type Api,
	getApiProvider,
	getModel,
	type Model,
	registerApiProvider,
	resetApiProviders,
} from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { prewarmDefaultModelApi, prewarmModelApi } from "../src/core/model-api-prewarm.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const PREWARM = Symbol.for("@bastani/atomic-ai/api-prewarm");
const roots: string[] = [];

afterEach(() => {
	resetApiProviders();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** Counts each load of Atomic's own implementation of `api` that a prewarm starts. */
function countLoads(api: Api): { readonly count: number } {
	const counter = { count: 0 };
	Object.defineProperty(getApiProvider(api)!, PREWARM, {
		value: async () => {
			counter.count++;
		},
		enumerable: false,
		configurable: true,
	});
	return counter;
}

/** A stream an extension implements itself; never called here. */
const ownStream = () => createAssistantMessageEventStream();

function modelConfig(id: string, api: Api) {
	return {
		id,
		name: id,
		api,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1_000,
	};
}

async function runtimeWith(modelsJson?: object): Promise<ModelRuntime> {
	let modelsPath: string | null = null;
	if (modelsJson) {
		modelsPath = join(tempDir("atomic-prewarm-models-"), "models.json");
		writeFileSync(modelsPath, JSON.stringify(modelsJson));
	}
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "test" },
			proxy: { type: "api_key", key: "test" },
		}),
		modelsPath,
		allowModelNetwork: false,
	});
}

describe("the API implementation a prewarm loads", () => {
	test("a model of a built-in provider: Atomic's implementation of its api, which its requests use", async () => {
		const runtime = await runtimeWith();
		const loads = countLoads("anthropic-messages");
		await prewarmModelApi(getModel("anthropic", "claude-sonnet-4-5"), runtime);
		assert.equal(loads.count, 1);
	});

	test("a model an extension registered with its own streamSimple: nothing, as its requests never use Atomic's", async () => {
		const runtime = await runtimeWith();
		runtime.registerProvider("proxy", {
			baseUrl: "http://127.0.0.1:9",
			apiKey: "test",
			api: "anthropic-messages",
			streamSimple: ownStream,
			models: [modelConfig("proxy-model", "anthropic-messages")],
		});
		const loads = countLoads("anthropic-messages");
		await prewarmModelApi(runtime.getModel("proxy", "proxy-model"), runtime);
		// An extension that streams a built-in provider's requests itself.
		runtime.registerProvider("anthropic", { api: "anthropic-messages", streamSimple: ownStream });
		await prewarmModelApi(runtime.getModel("anthropic", "claude-sonnet-4-5"), runtime);
		// An alias of a provider an extension streams.
		runtime.registerProvider("proxy-alias", { aliasOf: "proxy" });
		await prewarmModelApi({ provider: "proxy-alias", api: "anthropic-messages" }, runtime);
		// A provider an extension streams, named by its older id.
		runtime.registerProvider("azure", { api: "azure-openai-responses", streamSimple: ownStream });
		const azure = countLoads("azure-openai-responses");
		await prewarmModelApi({ provider: "azure-openai-responses", api: "azure-openai-responses" }, runtime);
		assert.equal(loads.count, 0);
		assert.equal(azure.count, 0);
	});

	test("a provider an extension brings with its own stream functions: nothing", async () => {
		const runtime = await runtimeWith();
		const native = getModel("anthropic", "claude-sonnet-4-5") as Model<Api>;
		runtime.registerNativeProvider({
			id: "native",
			name: "native",
			auth: { apiKey: { resolve: async () => ({ apiKey: "test" }) } },
			getModels: () => [{ ...native, provider: "native" }],
			stream: ownStream,
			streamSimple: ownStream,
		} as unknown as Parameters<ModelRuntime["registerNativeProvider"]>[0]);
		const loads = countLoads("anthropic-messages");
		await prewarmModelApi({ provider: "native", api: "anthropic-messages" }, runtime);
		assert.equal(loads.count, 0);
	});

	test("a models.json provider: Atomic's implementation of a built-in api it names, nothing for a custom api", async () => {
		const runtime = await runtimeWith({
			providers: {
				local: {
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "test",
					api: "openai-completions",
					models: [modelConfig("local-model", "openai-completions")],
				},
				custom: {
					baseUrl: "http://127.0.0.1:9",
					apiKey: "test",
					api: "custom-wire",
					models: [modelConfig("custom-model", "custom-wire" as Api)],
				},
			},
		});
		// An extension implements the custom api through the api registry, with no prewarm of its own.
		registerApiProvider({ api: "custom-wire" as Api, stream: ownStream, streamSimple: ownStream });
		const openai = countLoads("openai-completions");
		const anthropic = countLoads("anthropic-messages");
		await prewarmModelApi(runtime.getModel("local", "local-model"), runtime);
		await prewarmModelApi(runtime.getModel("custom", "custom-model"), runtime);
		assert.equal(openai.count, 1);
		assert.equal(anthropic.count, 0);
	});

	test("a switch before the first prompt loads the api of the model switched to, and nothing for an extension's", async () => {
		const runtime = await runtimeWith();
		runtime.registerProvider("proxy", {
			baseUrl: "http://127.0.0.1:9",
			apiKey: "test",
			api: "anthropic-messages",
			streamSimple: ownStream,
			models: [modelConfig("proxy-model", "anthropic-messages")],
		});
		const cwd = tempDir("atomic-prewarm-session-");
		const services = await createAgentSessionServices({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			model: runtime.getModel("proxy", "proxy-model"),
			noTools: true,
		});
		try {
			const loads = countLoads("anthropic-messages");
			await session.setModel(runtime.getModel("anthropic", "claude-sonnet-4-5")!);
			assert.equal(loads.count, 1);
			await session.setModel(runtime.getModel("proxy", "proxy-model")!);
			assert.equal(loads.count, 1);
		} finally {
			await session.dispose();
		}
	});
});

describe("the API implementation a prewarmed engine loads while it waits for its host", () => {
	/** An agent directory whose settings choose a built-in provider's model, beside an empty project. */
	function agentDirWithDefault(settings: object = {}): { agentDir: string; cwd: string } {
		const agentDir = tempDir("atomic-prewarm-agent-");
		const cwd = tempDir("atomic-prewarm-project-");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5", ...settings }),
		);
		return { agentDir, cwd };
	}

	test("loads the api of the default model the settings select, beside extensions, packages, a model scope or project models", async () => {
		const loads = countLoads("anthropic-messages");
		const plain = agentDirWithDefault();
		await prewarmDefaultModelApi(plain.agentDir, plain.cwd);
		const configured = agentDirWithDefault({
			extensions: ["./other.ts"],
			packages: ["npm:some-package"],
			enabledModels: ["anthropic/*"],
		});
		mkdirSync(join(configured.agentDir, "extensions"));
		writeFileSync(join(configured.agentDir, "extensions", "noop.ts"), "export default () => {};\n");
		mkdirSync(join(configured.cwd, ".atomic"));
		writeFileSync(join(configured.cwd, ".atomic", "models.json"), JSON.stringify({ providers: {} }));
		await prewarmDefaultModelApi(configured.agentDir, configured.cwd);
		assert.equal(loads.count, 2);
	});

	test("loads the api of the default model a project's settings select over the agent directory's", async () => {
		const { agentDir, cwd } = agentDirWithDefault();
		mkdirSync(join(cwd, ".atomic"));
		writeFileSync(
			join(cwd, ".atomic", "settings.json"),
			JSON.stringify({ defaultProvider: "local", defaultModel: "local-model" }),
		);
		writeFileSync(
			join(cwd, ".atomic", "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: "http://127.0.0.1:9/v1",
						apiKey: "test",
						api: "openai-completions",
						models: [modelConfig("local-model", "openai-completions")],
					},
				},
			}),
		);
		const anthropic = countLoads("anthropic-messages");
		const openai = countLoads("openai-completions");
		await prewarmDefaultModelApi(agentDir, cwd);
		assert.deepEqual([anthropic.count, openai.count], [0, 1]);
	});

	test("loads nothing for a provider only an extension registers, or a models.json provider with an api Atomic does not implement", async () => {
		const loads = countLoads("anthropic-messages");
		const extensionOnly = agentDirWithDefault({ defaultProvider: "proxy", defaultModel: "proxy-model" });
		await prewarmDefaultModelApi(extensionOnly.agentDir, extensionOnly.cwd);
		const customApi = agentDirWithDefault({ defaultProvider: "custom", defaultModel: "custom-model" });
		writeFileSync(
			join(customApi.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "http://127.0.0.1:9",
						apiKey: "test",
						api: "custom-wire",
						models: [modelConfig("custom-model", "custom-wire" as Api)],
					},
				},
			}),
		);
		await prewarmDefaultModelApi(customApi.agentDir, customApi.cwd);
		assert.equal(loads.count, 0);
	});
});

describe("the API implementation an SDK session loads as it is created", () => {
	async function createSession(extensionTakesOverAnthropic: boolean) {
		const cwd = tempDir("atomic-prewarm-sdk-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.inMemory();
		// The resource loader the SDK is given: its extensions' provider registrations wait for the session to bind them.
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: extensionTakesOverAnthropic
				? [(pi) => pi.registerProvider("anthropic", { api: "anthropic-messages", streamSimple: ownStream })]
				: [],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			authStorage: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test" } }),
			resourceLoader,
			builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
		});
		return session;
	}

	test("loads the api of a built-in provider's model, and nothing once an extension it loaded streams that provider", async () => {
		const loads = countLoads("anthropic-messages");
		const plain = await createSession(false);
		await plain.dispose();
		assert.equal(loads.count, 1);
		const takenOver = await createSession(true);
		await takenOver.dispose();
		assert.equal(loads.count, 1);
	});
});
