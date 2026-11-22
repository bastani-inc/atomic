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
import { prewarmHostDefaultModelApi } from "../src/core/default-model-api-prewarm.ts";
import { prewarmModelApi } from "../src/core/model-api-prewarm.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

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
		// One that lists no models yet, as a provider that fetches its list later: its requests still reach its stream.
		runtime.registerNativeProvider({
			id: "native-later",
			name: "native-later",
			auth: { apiKey: { resolve: async () => ({ apiKey: "test" }) } },
			getModels: () => [],
			stream: ownStream,
			streamSimple: ownStream,
		} as unknown as Parameters<ModelRuntime["registerNativeProvider"]>[0]);
		const loads = countLoads("anthropic-messages");
		await prewarmModelApi({ provider: "native", api: "anthropic-messages" }, runtime);
		await prewarmModelApi({ provider: "native-later", api: "anthropic-messages" }, runtime);
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
	test("a cycle before the first prompt loads the api of the model it selects, as a switch does", async () => {
		const runtime = await runtimeWith();
		runtime.registerProvider("proxy", {
			baseUrl: "http://127.0.0.1:9",
			apiKey: "test",
			api: "anthropic-messages",
			streamSimple: ownStream,
			models: [modelConfig("proxy-model", "anthropic-messages")],
		});
		const cwd = tempDir("atomic-prewarm-cycle-");
		const services = await createAgentSessionServices({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
		});
		const proxy = runtime.getModel("proxy", "proxy-model")!;
		const anthropic = runtime.getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			model: proxy,
			noTools: true,
		});
		try {
			const loads = countLoads("anthropic-messages");
			// Through the models a scope lists.
			session.setScopedModels([{ model: proxy }, { model: anthropic }]);
			assert.equal((await session.cycleModel("forward"))?.model.provider, "anthropic");
			assert.equal(loads.count, 1);
			assert.equal((await session.cycleModel("forward"))?.model.provider, "proxy");
			assert.equal(loads.count, 1);
			// Through every model with credentials: after the extension's only model come Atomic's Anthropic ones.
			session.setScopedModels([]);
			assert.equal((await session.cycleModel("forward"))?.model.provider, "anthropic");
			assert.equal(loads.count, 2);
		} finally {
			await session.dispose();
		}
	});
});

describe("the API implementation a prewarmed engine loads while it waits for its host", () => {
	/** Options that leave the session's model to the settings, as a benchmark or a user starts Atomic. */
	const PLAIN_ARGS = ["--offline", "--no-mcp"];

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

	function writeProjectFile(cwd: string, name: string, content: object): void {
		mkdirSync(join(cwd, ".atomic"), { recursive: true });
		writeFileSync(join(cwd, ".atomic", name), JSON.stringify(content));
	}

	test("loads the api of the default model the settings select, beside extensions, packages, a model scope or project models", async () => {
		const loads = countLoads("anthropic-messages");
		const plain = agentDirWithDefault();
		await prewarmHostDefaultModelApi(PLAIN_ARGS, plain.agentDir, plain.cwd);
		const configured = agentDirWithDefault({
			extensions: ["./other.ts"],
			packages: ["npm:some-package"],
			enabledModels: ["anthropic/*"],
		});
		mkdirSync(join(configured.agentDir, "extensions"));
		writeFileSync(join(configured.agentDir, "extensions", "noop.ts"), "export default () => {};\n");
		writeProjectFile(configured.cwd, "models.json", { providers: {} });
		await prewarmHostDefaultModelApi(PLAIN_ARGS, configured.agentDir, configured.cwd);
		assert.equal(loads.count, 2);
	});

	test("loads the api of a models.json provider's default model, read from the agent directory's models.json", async () => {
		const { agentDir, cwd } = agentDirWithDefault({ defaultProvider: "local", defaultModel: "local-model" });
		writeFileSync(
			join(agentDir, "models.json"),
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
		await prewarmHostDefaultModelApi(PLAIN_ARGS, agentDir, cwd);
		assert.deepEqual([anthropic.count, openai.count], [0, 1]);
	});

	test("ignores a project's models.json and an older agent directory's, which the session's model runtime never reads", async () => {
		const anthropic = countLoads("anthropic-messages");
		const openai = countLoads("openai-completions");
		// A project models.json that would give the default model another api.
		const builtin = agentDirWithDefault();
		writeProjectFile(builtin.cwd, "models.json", {
			providers: {
				anthropic: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					models: [modelConfig("claude-sonnet-4-5", "openai-completions")],
				},
			},
		});
		await prewarmHostDefaultModelApi(["--approve"], builtin.agentDir, builtin.cwd);
		// A project models.json that would give a provider only an extension registers a built-in api.
		const extensionOnly = agentDirWithDefault({ defaultProvider: "proxy", defaultModel: "proxy-model" });
		writeProjectFile(extensionOnly.cwd, "models.json", {
			providers: {
				proxy: {
					baseUrl: "http://127.0.0.1:9",
					apiKey: "test",
					api: "anthropic-messages",
					models: [modelConfig("proxy-model", "anthropic-messages")],
				},
			},
		});
		await prewarmHostDefaultModelApi(["--approve"], extensionOnly.agentDir, extensionOnly.cwd);
		assert.deepEqual([anthropic.count, openai.count], [1, 0]);
	});

	test("reads a project's default model only when the project is trusted before any extension runs, as the session's settings are", async () => {
		const anthropic = countLoads("anthropic-messages");
		const openai = countLoads("openai-responses");
		const loadsFor = async (args: string[], setup: (dirs: { agentDir: string; cwd: string }) => Promise<void>) => {
			const before = [anthropic.count, openai.count];
			const dirs = agentDirWithDefault();
			writeProjectFile(dirs.cwd, "settings.json", { defaultProvider: "openai", defaultModel: "gpt-4o" });
			await setup(dirs);
			await prewarmHostDefaultModelApi(args, dirs.agentDir, dirs.cwd);
			return [anthropic.count - before[0]!, openai.count - before[1]!];
		};
		const nothing = async () => {};
		const saveTrust = async ({ agentDir, cwd }: { agentDir: string; cwd: string }) =>
			new ProjectTrustStore(agentDir).setAsync(cwd, true);
		// --approve and --no-approve decide, the last one given.
		assert.deepEqual(await loadsFor(["--approve"], nothing), [0, 1], "--approve");
		assert.deepEqual(await loadsFor(["--no-approve"], nothing), [1, 0], "--no-approve");
		assert.deepEqual(await loadsFor(["-a", "-na"], nothing), [1, 0], "-a -na");
		assert.deepEqual(await loadsFor(["--no-approve"], saveTrust), [1, 0], "--no-approve over a saved trust");
		// Not yet decided: the project's settings wait for the decision, as the session's do.
		assert.deepEqual(await loadsFor(PLAIN_ARGS, nothing), [1, 0], "undecided");
		// A saved decision, or defaultProjectTrust "always", that no extension loading first could overturn.
		assert.deepEqual(await loadsFor(PLAIN_ARGS, saveTrust), [0, 1], "saved trust");
		assert.deepEqual(
			await loadsFor(PLAIN_ARGS, async ({ agentDir }) =>
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({
						defaultProvider: "anthropic",
						defaultModel: "claude-sonnet-4-5",
						defaultProjectTrust: "always",
					}),
				),
			),
			[0, 1],
			"defaultProjectTrust always",
		);
		assert.deepEqual(
			await loadsFor(PLAIN_ARGS, async (dirs) => {
				await saveTrust(dirs);
				mkdirSync(join(dirs.agentDir, "extensions"));
				writeFileSync(join(dirs.agentDir, "extensions", "trust.ts"), "export default () => {};\n");
			}),
			[1, 0],
			"saved trust an extension could overturn",
		);
	});

	test("finds a provider named by its older id in models.json and settings, as the session does", async () => {
		const azure = countLoads("azure-openai-responses");
		const openai = countLoads("openai-responses");
		// models.json configures the provider under its older id with an api Atomic does not implement.
		const custom = agentDirWithDefault({ defaultProvider: "azure", defaultModel: "gpt-4o" });
		writeFileSync(
			join(custom.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"azure-openai-responses": {
						baseUrl: "http://127.0.0.1:9",
						apiKey: "test",
						api: "custom-wire",
						models: [modelConfig("gpt-4o", "custom-wire" as Api)],
					},
				},
			}),
		);
		await prewarmHostDefaultModelApi(PLAIN_ARGS, custom.agentDir, custom.cwd);
		// The settings name the provider by its older id; models.json configures it under its current one.
		const deployment = agentDirWithDefault({ defaultProvider: "azure-openai-responses", defaultModel: "my-deploy" });
		writeFileSync(
			join(deployment.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					azure: {
						baseUrl: "http://127.0.0.1:9",
						apiKey: "test",
						api: "openai-responses",
						models: [modelConfig("my-deploy", "openai-responses")],
					},
				},
			}),
		);
		await prewarmHostDefaultModelApi(PLAIN_ARGS, deployment.agentDir, deployment.cwd);
		assert.deepEqual([azure.count, openai.count], [0, 1]);
	});

	test("loads it for a host whose arguments leave the model to the settings, as the command line reads them", async () => {
		const loads = countLoads("anthropic-messages");
		const keep = [
			["--approve", "--", "- summarize this"],
			["--no-session", "--", "--model", "openai/gpt-4o"],
			["--session-dir", "sessions"],
			["--storage-file", "storage.json"],
			["--session-store", "sessions.sqlite", "--session-prefix", "p_"],
			["--fallback-models", "openai/gpt-4o"],
			["--thinking", "high", "--tools", "read,bash", "--no-skills", "--no-themes", "--no-prompt-templates"],
			["--approve", "-n", "review", "fix the failing test", "@src/a.ts"],
			["--use-theme", "dark", "--no-extensions"],
		];
		for (const args of keep) {
			const before = loads.count;
			const { agentDir, cwd } = agentDirWithDefault();
			await prewarmHostDefaultModelApi(args, agentDir, cwd);
			assert.equal(loads.count - before, 1, args.join(" "));
		}
		// Arguments that may choose another model or session, or load an extension, than the settings do.
		const choose = [
			["--model", "gpt-5"],
			["--provider", "openai"],
			["--models", "openai/*"],
			["-c"],
			["--resume"],
			["--session", "id"],
			["--session-id", "id"],
			["--fork", "id"],
			["--extension", "./proxy.ts"],
			["--approve", "-e", "./proxy.ts"],
			["--an-extension-flag", "value"],
		];
		for (const args of choose) {
			const before = loads.count;
			const { agentDir, cwd } = agentDirWithDefault();
			await prewarmHostDefaultModelApi(args, agentDir, cwd);
			assert.equal(loads.count - before, 0, args.join(" "));
		}
	});

	test("loads nothing for a provider only an extension registers, or a models.json provider with an api Atomic does not implement", async () => {
		const loads = countLoads("anthropic-messages");
		const extensionOnly = agentDirWithDefault({ defaultProvider: "proxy", defaultModel: "proxy-model" });
		await prewarmHostDefaultModelApi(PLAIN_ARGS, extensionOnly.agentDir, extensionOnly.cwd);
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
		await prewarmHostDefaultModelApi(PLAIN_ARGS, customApi.agentDir, customApi.cwd);
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
