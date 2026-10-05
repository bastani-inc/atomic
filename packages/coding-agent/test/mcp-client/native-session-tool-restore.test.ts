import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemMessage } from "@bastani/pi-ai";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	registerApiProvider,
	registerFauxProvider,
} from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../src/core/models-store.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { type CreateAgentSessionResult, createAgentSession, createUnstartedAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "../../src/extensions/mcp/client/index.ts";
import { createInMemoryTransportPair } from "../../src/extensions/mcp/client/testing/index.ts";
import type { McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createTestUiContext } from "./native-test-ui.ts";

/** `initialize` is answered after `initializeDelay` ms, or once that promise settles. */
function createFakeServer(initializeDelay: number | Promise<unknown>) {
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "docs", version: "1.0.0" },
				};
			case "tools/list":
				return {
					tools: [
						{
							name: "search",
							description: "Search the docs.",
							inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
						},
					],
				};
			case "tools/call": {
				const params = request.params as { arguments?: { query?: string } };
				const hits = [`${params.arguments?.query} guide`, `${params.arguments?.query} faq`];
				return { content: [{ type: "text", text: hits.join("\n") }] };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const send = () => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		if (request.method !== "initialize" || initializeDelay === 0) queueMicrotask(send);
		else if (typeof initializeDelay === "number") setTimeout(send, initializeDelay);
		else void initializeDelay.then(send);
	});
	return pair;
}

describe("AgentSession MCP tools after resume and reload", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function setup(
		sessionManager?: SessionManager,
		extensionFactories: ExtensionFactory[] = [],
		initializeDelayMs = 0,
		selection: { allowedToolNames?: string[]; excludedToolNames?: string[]; exposure?: "direct" | "deferred" } = {},
	) {
		const connected: string[] = [];
		const servers: McpServerEntry[] = [
			{
				name: "docs",
				config: { url: "http://unused.invalid", exposure: selection.exposure ?? "deferred" },
				source: "test",
			},
		];
		const factories = [
			...extensionFactories,
			{ factory: createToolSearchExtension(), path: "builtin:tool-search" },
			createMcpExtension({
				loadConfig: () => ({ servers, errors: [] }),
				createTransport: (entry) => {
					connected.push(entry.name);
					const pair = createFakeServer(initializeDelayMs);
					void pair.server.start();
					return pair.client;
				},
			}),
		];
		let extensions = await createTestExtensionsResult(factories);
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await createTestExtensionsResult(factories);
			},
		};
		const harness = await createHarness({
			resourceLoader,
			sessionManager,
			...selection,
			initialActiveToolNames: selection.allowedToolNames,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected };
	}

	async function loadDocsSearch(harness: Harness) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("loaded"),
		]);
		await harness.session.prompt("load");
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
	}

	it("keeps unnamed MCP tools callable and lets tool_search load them", async () => {
		const { harness } = await setup(undefined, [], 0, { allowedToolNames: ["read", "tool_search"] });
		await loadDocsSearch(harness);
		expect(harness.session.getCallableToolNames()).toContain("mcp__docs__search");
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("bash");
	});

	it("does not redeclare unnamed direct MCP tools from a restored transcript", async () => {
		const first = await setup(undefined, [], 0, { exposure: "direct" });
		first.harness.setResponses([fauxAssistantMessage("done")]);
		await first.harness.session.prompt("go");
		expect(first.harness.session.getActiveToolNames()).toContain("mcp__docs__search");
		const second = await setup(first.harness.sessionManager, [], 0, {
			allowedToolNames: ["read", "tool_search"],
			exposure: "direct",
		});
		second.harness.setResponses([fauxAssistantMessage("done")]);
		await second.harness.session.prompt("go");
		expect(second.harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__search");
		expect(second.harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
		second.harness.session.setActiveToolsByName(["mcp__docs__search"]);
		expect(second.harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
	});

	it.each([
		{ allowedToolNames: ["read", "mcp__docs__s*"], excludedToolNames: [], kept: true },
		{ allowedToolNames: ["read", "mcp__other__*"], excludedToolNames: [], kept: false },
		{ allowedToolNames: ["read"], excludedToolNames: ["mcp__docs__*"], kept: false },
		{ allowedToolNames: [], excludedToolNames: [], kept: false },
	])(
		"applies MCP patterns and empty allowlists: $allowedToolNames / $excludedToolNames",
		async ({ kept, ...selection }) => {
			const { harness } = await setup(undefined, [], 0, { ...selection, exposure: "direct" });
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("go");
			expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(kept);
			expect(harness.session.getActiveToolNames().includes("mcp__docs__search")).toBe(kept);
		},
	);

	it("declares tools tool_search loaded again on resume once their server connects", async () => {
		const first = await setup();
		await loadDocsSearch(first.harness);

		const second = await setup(first.harness.sessionManager);
		await vi.waitFor(() => expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "again" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await second.harness.session.prompt("use it");

		const result = second.harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "mcp__docs__search",
		);
		expect(getMessageText(result)).toBe("again guide\nagain faq");
		const removals = second.harness.session.messages.filter(
			(message) => message.role === "system" && (message.toolsRemoved ?? []).length > 0,
		);
		expect(removals).toEqual([]);
	});

	it.each([
		["drops", ["read"], false],
		["keeps", undefined, true],
	] as const)(
		"%s restored tools when an extension sets the loadout before they register",
		async (_, loadout, kept) => {
			const first = await setup();
			await loadDocsSearch(first.harness);

			const setLoadout: ExtensionFactory = (pi) => {
				pi.on("session_start", () => pi.setActiveTools(loadout ? [...loadout] : [...pi.getActiveTools(), "read"]));
			};
			const second = await setup(first.harness.sessionManager, [setLoadout]);
			await vi.waitFor(() =>
				expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
			);

			expect(second.harness.session.getActiveToolNames().includes("mcp__docs__search")).toBe(kept);
		},
	);

	it("does not activate restored tools that register after the next prompt starts", async () => {
		const first = await setup();
		await loadDocsSearch(first.harness);

		const second = await setup(first.harness.sessionManager, [], 200);
		second.harness.setResponses([fauxAssistantMessage("done")]);
		await second.harness.session.prompt("go");
		await vi.waitFor(() =>
			expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);

		expect(second.harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
	});

	it("declares tools tool_search loaded again after /reload", async () => {
		const { harness, connected } = await setup();
		await loadDocsSearch(harness);

		await harness.session.reload();

		await vi.waitFor(() => expect(connected).toEqual(["docs", "docs"]));
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
	});
});

/**
 * The CLI resumes through `createAgentSession` over a file-backed session: it always passes the
 * configured loadout and loads the MCP extension, whose servers register their tools after the
 * session exists. The suite harness above builds `AgentSession` directly, so it cannot see how a
 * caller-supplied loadout meets the transcript.
 */
describe("AgentSession MCP tools after resuming a file-backed session through createAgentSession", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	const noBuiltinPackages = { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false };

	async function createFixture() {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-mcp-resume-"));
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		modelRuntime.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				inputLimits: model.inputLimits,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});
		// A reload resets the global API registry, which drops this test-only API. Real providers are
		// built in and come back with it, so put the faux one back after startup reloads.
		const fauxStreams = getApiProvider(faux.api)!;
		const restoreFauxApi = () =>
			registerApiProvider({ api: faux.api, stream: fauxStreams.stream, streamSimple: fauxStreams.streamSimple });
		cleanups.push(() => {
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
		});
		return { cwd, agentDir, faux, modelRuntime, restoreFauxApi };
	}

	type Fixture = Awaited<ReturnType<typeof createFixture>>;

	/** What `atomic` does for a stored session: file-backed manager, deferred MCP server, same model. */
	async function startSession(
		fixture: Fixture,
		sessionManager: SessionManager,
		options: {
			deferExtensions?: boolean;
			/** The server answers `initialize` once this settles, as a spawned stdio server does after startup. */
			serverReady?: Promise<unknown>;
			sessionOptions?: { noTools?: "all" | "builtin"; tools?: string[] };
		} = {},
	) {
		const settingsManager = SettingsManager.inMemory();
		const servers: McpServerEntry[] = [
			{ name: "docs", config: { url: "http://unused.invalid", exposure: "deferred" }, source: "test" },
		];
		const resourceLoader = new DefaultResourceLoader({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [
				...builtInExtensions,
				createMcpExtension({
					loadConfig: () => ({ servers, errors: [] }),
					createTransport: () => {
						const pair = createFakeServer(options.serverReady ?? 0);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		await resourceLoader.reload(
			options.deferExtensions ? { deferExtensions: true, deferResources: true } : undefined,
		);
		const create = options.deferExtensions ? createUnstartedAgentSession : createAgentSession;
		const created: CreateAgentSessionResult = await create({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager,
			resourceLoader,
			modelRuntime: fixture.modelRuntime,
			model: fixture.faux.getModel(),
			sessionManager,
			builtins: noBuiltinPackages,
			...options.sessionOptions,
		});
		cleanups.push(() => created.session.dispose());
		if (options.deferExtensions) {
			// Interactive startup paints first, then loads the extensions with a startup reload.
			await created.session.bindExtensions({ uiContext: createTestUiContext() });
			await created.session.reload({ reason: "startup" });
			fixture.restoreFauxApi();
		}
		return created.session;
	}

	/** A first process loads the deferred tool with tool_search and quits; returns the stored session file. */
	async function loadDocsSearchAndQuit(fixture: Fixture): Promise<string> {
		const manager = SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
		const first = await startSession(fixture, manager);
		fixture.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("loaded"),
		]);
		await first.prompt("load");
		expect(first.getActiveToolNames()).toContain("mcp__docs__search");
		await first.dispose();
		return manager.getSessionFile()!;
	}

	/** Resume the stored session with a server that connects only after startup finished. */
	async function resume(
		fixture: Fixture,
		sessionFile: string,
		options: Parameters<typeof startSession>[2] = {},
	): Promise<{ session: Awaited<ReturnType<typeof startSession>>; connectServer: () => void }> {
		let connectServer!: () => void;
		const serverReady = new Promise<void>((resolve) => {
			connectServer = resolve;
		});
		const session = await startSession(fixture, SessionManager.open(sessionFile, undefined, fixture.cwd), {
			...options,
			serverReady,
		});
		return { session, connectServer };
	}

	it.each([
		{ startup: "eager", deferExtensions: false },
		{ startup: "deferred extension load", deferExtensions: true },
	])(
		"declares tools tool_search loaded in the stored session once their server connects ($startup)",
		async ({ deferExtensions }) => {
			const fixture = await createFixture();
			const sessionFile = await loadDocsSearchAndQuit(fixture);

			const { session: resumed, connectServer } = await resume(fixture, sessionFile, { deferExtensions });

			// The stored transcript declared the tool, so the resumed session must keep declaring it.
			expect(getCurrentSystemMessage(resumed.messages)?.toolsAdded?.map((tool) => tool.name)).toContain(
				"mcp__docs__search",
			);
			connectServer();
			await vi.waitFor(() => expect(resumed.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__search"));
			expect(resumed.getActiveToolNames()).toContain("mcp__docs__search");
			fixture.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "again" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await resumed.prompt("use it");

			const result = resumed.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "mcp__docs__search",
			);
			expect(getMessageText(result)).toBe("again guide\nagain faq");
			expect(
				resumed.messages.filter((message) => message.role === "system" && (message.toolsRemoved ?? []).length > 0),
			).toEqual([]);
		},
	);

	it("keeps the built-in loadout --no-builtin-tools asked for when it restores the stored session's other tools", async () => {
		const fixture = await createFixture();
		const sessionFile = await loadDocsSearchAndQuit(fixture);

		const { session: resumed, connectServer } = await resume(fixture, sessionFile, {
			sessionOptions: { noTools: "builtin" },
		});
		connectServer();
		await vi.waitFor(() => expect(resumed.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__search"));

		// The stored transcript declared read and bash; the flag, not the transcript, decides them.
		const active = resumed.getActiveToolNames();
		expect(active).toContain("mcp__docs__search");
		expect(active).not.toContain("read");
		expect(active).not.toContain("bash");
	});
});
