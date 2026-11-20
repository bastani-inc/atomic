import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, resolveTranscriptTools } from "@bastani/atomic-ai";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	registerApiProvider,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage, InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../src/core/models-store.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import {
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAuthRequiredError,
} from "../../src/extensions/mcp/client/index.ts";
import { createInMemoryTransportPair } from "../../src/extensions/mcp/client/testing/index.ts";
import type { McpExposure, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import { MCP_TOOL_RECORD_ENTRY_TYPE } from "../../src/extensions/mcp/tool-records.ts";
import { createMcpToolName } from "../../src/extensions/mcp/tools.ts";
import { getMessageText } from "../suite/harness.ts";

interface ListedTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const SEARCH: ListedTool = {
	name: "search",
	description: "Search the docs.",
	inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const FETCH: ListedTool = {
	name: "fetch",
	description: "Fetch a page of the docs.",
	inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};

/** One MCP server process: what it lists, and when it answers `initialize`. */
interface ServerScript {
	tools: ListedTool[];
	/** `initialize` is answered once this settles; a rejection fails the connection. */
	ready?: Promise<unknown>;
	/** The server answers every connection with 401, as when its sign-in expired. */
	needsSignIn?: boolean;
	/** Resources the server lists; a server without them does not offer resources. */
	resources?: { uri: string; name: string }[];
	calls: string[];
}

function createFakeServer(script: ServerScript) {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const answer = (result: unknown) => void pair.server.send({ jsonrpc: "2.0", id: request.id, result });
		switch (request.method) {
			case "initialize": {
				const result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, ...(script.resources ? { resources: {} } : {}) },
					serverInfo: { name: "docs", version: "1.0.0" },
				};
				if (!script.ready) queueMicrotask(() => answer(result));
				else
					void script.ready.then(
						() => answer(result),
						(error: unknown) =>
							void pair.server.send({
								jsonrpc: "2.0",
								id: request.id,
								error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
							}),
					);
				return;
			}
			case "tools/list":
				queueMicrotask(() => answer({ tools: script.tools }));
				return;
			case "resources/list":
				script.calls.push(request.method);
				queueMicrotask(() => answer({ resources: script.resources ?? [] }));
				return;
			case "tools/call": {
				const params = request.params as { name: string; arguments?: { query?: string } };
				script.calls.push(params.name);
				queueMicrotask(() => answer({ content: [{ type: "text", text: `${params.arguments?.query} guide` }] }));
				return;
			}
			default:
				queueMicrotask(() => answer({}));
		}
	});
	return pair;
}

function toolNames(tools: string): string[] {
	return (JSON.parse(tools) as { name: string }[]).map((tool) => tool.name);
}

/** What a transport without mid-conversation tool changes sends as its top-level tools field. */
function flatTools(context: Context): string {
	return JSON.stringify(resolveTranscriptTools(context.messages, "none").requestTools);
}

describe("MCP tools of a resumed session while their server reconnects", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createFixture() {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-mcp-resume-loadout-"));
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
		const fauxStreams = getApiProvider(faux.api)!;
		const restoreFauxApi = () =>
			registerApiProvider({ api: faux.api, stream: fauxStreams.stream, streamSimple: fauxStreams.streamSimple });
		/** The top-level tools field of every request, in order. */
		const requests: string[] = [];
		const reply = (text: string) => (context: Context) => {
			requests.push(flatTools(context));
			return fauxAssistantMessage(text);
		};
		const callTool = (name: string, args: Record<string, unknown>) => (context: Context) => {
			requests.push(flatTools(context));
			return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
		};
		cleanups.push(() => {
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
		});
		return { cwd, agentDir, faux, modelRuntime, restoreFauxApi, requests, reply, callTool };
	}

	type Fixture = Awaited<ReturnType<typeof createFixture>>;

	interface StartOptions {
		servers: Record<string, ServerScript>;
		exposure?: McpExposure;
		/** How long the first prompt waits for servers with direct tools. */
		startupWaitMs?: number;
		/** Server URLs, by server name; `http://<name>.invalid/mcp` by default. */
		urls?: Record<string, string>;
	}

	/** What `atomic --resume` does for a stored session: file-backed manager, the MCP servers from mcp.json, same model. */
	async function startSession(fixture: Fixture, sessionManager: SessionManager, options: StartOptions) {
		const settingsManager = SettingsManager.inMemory();
		const entries: McpServerEntry[] = Object.keys(options.servers).map((name) => ({
			name,
			config: { url: options.urls?.[name] ?? `http://${name}.invalid/mcp`, exposure: options.exposure ?? "direct" },
			source: "test",
		}));
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
					loadConfig: () => ({ servers: entries, errors: [] }),
					createTransport: async (entry) => {
						const script = options.servers[entry.name]!;
						if (script.needsSignIn) {
							await script.ready;
							throw new McpAuthRequiredError(new Response(null, { status: 401 }));
						}
						const pair = createFakeServer(script);
						void pair.server.start();
						return pair.client;
					},
					credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
					startupWaitMs: options.startupWaitMs,
				}),
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager,
			resourceLoader,
			modelRuntime: fixture.modelRuntime,
			model: fixture.faux.getModel(),
			sessionManager,
			builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
		});
		cleanups.push(() => session.dispose());
		fixture.restoreFauxApi();
		return session;
	}

	/** A first process that declared the server's tools; it sends one more request (the control) and quits. */
	async function liveSession(fixture: Fixture, options: StartOptions, tool = "mcp__docs__search") {
		const manager = await SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
		const live = await startSession(fixture, manager, options);
		await vi.waitFor(() => expect(live.getActiveToolNames()).toContain(tool));
		fixture.faux.setResponses([fixture.reply("one")]);
		await live.prompt("first");
		// The control: the request the same process sends next, without a resume.
		fixture.faux.setResponses([fixture.reply("two")]);
		await live.prompt("second");
		const control = fixture.requests.at(-1)!;
		expect(toolNames(control)).toContain(tool);
		await live.dispose();
		return { sessionFile: manager.getSessionFile()!, control };
	}

	function held() {
		let release!: () => void;
		let fail!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => {
			release = resolve;
			fail = reject;
		});
		ready.catch(() => {});
		return { ready, release, fail };
	}

	function toolChanges(session: AgentSession, from: number) {
		return session.messages
			.slice(from)
			.filter((message) => message.role === "system" && (message.toolsAdded || message.toolsRemoved))
			.map((message) =>
				message.role === "system"
					? {
							added: (message.toolsAdded ?? []).map((tool) => tool.name).sort(),
							removed: (message.toolsRemoved ?? []).map((tool) => tool.name).sort(),
						}
					: undefined,
			);
	}

	it("keeps the tools field of a flat-tool request unchanged while a direct server reconnects after the startup wait", async () => {
		const fixture = await createFixture();
		const { sessionFile, control } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
		});

		const server = held();
		const resumed = await startSession(fixture, await SessionManager.open(sessionFile, undefined, fixture.cwd), {
			servers: { docs: { tools: [SEARCH], ready: server.ready, calls: [] } },
			startupWaitMs: 10,
		});
		const before = resumed.messages.length;
		fixture.faux.setResponses([fixture.reply("three")]);
		await resumed.prompt("after resume");
		expect(fixture.requests.at(-1)).toBe(control);

		server.release();
		await vi.waitFor(() =>
			expect(resumed.getAllTools().find((tool) => tool.name === "mcp__docs__search")?.sourceInfo).toBeDefined(),
		);
		fixture.faux.setResponses([fixture.reply("four")]);
		await resumed.prompt("after reconnect");
		expect(fixture.requests.at(-1)).toBe(control);
		expect(toolChanges(resumed, before)).toEqual([]);
	});

	async function resume(fixture: Fixture, sessionFile: string, options: StartOptions) {
		return startSession(fixture, await SessionManager.open(sessionFile, undefined, fixture.cwd), {
			startupWaitMs: 10,
			...options,
		});
	}

	/** Run a prompt whose first response calls `tool`; `whenCalled` runs once the call started executing. */
	async function promptCalling(
		fixture: Fixture,
		session: AgentSession,
		tool: string,
		whenCalled?: () => void,
		args: Record<string, unknown> = { query: "again" },
	) {
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === tool) whenCalled?.();
		});
		fixture.faux.setResponses([fixture.callTool(tool, args), fixture.reply("done")]);
		try {
			await session.prompt("use it");
		} finally {
			unsubscribe();
		}
		return session.messages.findLast((message) => message.role === "toolResult" && message.toolName === tool);
	}

	it("runs a call to a restored tool once its server reconnects", async () => {
		const fixture = await createFixture();
		const { sessionFile, control } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
		});

		const server = held();
		const script: ServerScript = { tools: [SEARCH], ready: server.ready, calls: [] };
		const resumed = await resume(fixture, sessionFile, { servers: { docs: script } });
		const before = resumed.messages.length;
		// The server answers only after the call started and everything it does without waiting has run.
		const result = await promptCalling(fixture, resumed, "mcp__docs__search", () => {
			expect(script.calls).toEqual([]);
			setTimeout(server.release, 0);
		});

		expect(getMessageText(result)).toBe("again guide");
		expect(script.calls).toEqual(["search"]);
		expect(fixture.requests.slice(-2)).toEqual([control, control]);
		expect(toolChanges(resumed, before)).toEqual([]);
	});

	it.each([
		{ outcome: "fails to connect", script: (ready: Promise<unknown>) => ({ ready, calls: [] }), fails: true },
		{ outcome: "needs a sign-in", script: (ready: Promise<unknown>) => ({ ready, needsSignIn: true, calls: [] }) },
	])("declares a restored tool removed, without calling it, once its server $outcome", async ({ script, fails }) => {
		const fixture = await createFixture();
		const { sessionFile, control } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
		});

		const server = held();
		const resumedScript: ServerScript = { tools: [SEARCH], ...script(server.ready) };
		const resumed = await resume(fixture, sessionFile, { servers: { docs: resumedScript } });
		const before = resumed.messages.length;
		const result = await promptCalling(fixture, resumed, "mcp__docs__search", () =>
			fails ? server.fail(new Error("server crashed")) : server.release(),
		);

		expect(result?.role === "toolResult" && result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/did not reconnect/);
		expect(resumedScript.calls).toEqual([]);
		// The request that called it was sent while the server was connecting; the one after the failed call
		// declares the tool removed.
		expect(fixture.requests.at(-2)).toBe(control);
		expect(toolNames(fixture.requests.at(-1)!)).not.toContain("mcp__docs__search");
		expect(toolChanges(resumed, before)).toEqual([{ added: [], removed: ["mcp__docs__search"] }]);
	});

	it("does not run a restored tool whose server lists a changed definition, and declares the change", async () => {
		const fixture = await createFixture();
		const { sessionFile } = await liveSession(fixture, { servers: { docs: { tools: [SEARCH], calls: [] } } });

		const server = held();
		const changed = { ...SEARCH, description: "Search the docs, newest first." };
		const script: ServerScript = { tools: [changed], ready: server.ready, calls: [] };
		const resumed = await resume(fixture, sessionFile, { servers: { docs: script } });
		const before = resumed.messages.length;
		const result = await promptCalling(fixture, resumed, "mcp__docs__search", () => server.release());

		expect(result?.role === "toolResult" && result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/changed since this session declared it/);
		expect(script.calls).toEqual([]);
		expect(toolChanges(resumed, before)).toEqual([{ added: ["mcp__docs__search"], removed: ["mcp__docs__search"] }]);
		const declared = JSON.parse(fixture.requests.at(-1)!) as { name: string; description: string }[];
		expect(declared.find((tool) => tool.name === "mcp__docs__search")?.description).toMatch(
			/^Search the docs, newest first\./,
		);
	});

	it.each([
		{ change: "is no longer configured", options: { servers: {} } },
		{
			change: "now points to another URL",
			options: {
				servers: { docs: { tools: [SEARCH], ready: new Promise(() => {}), calls: [] } },
				urls: { docs: "http://elsewhere.invalid/mcp" },
			},
		},
	])("declares the tools of a server that $change removed with the first request", async ({ options }) => {
		const fixture = await createFixture();
		const { sessionFile } = await liveSession(fixture, { servers: { docs: { tools: [SEARCH], calls: [] } } });

		const resumed = await resume(fixture, sessionFile, options);
		const before = resumed.messages.length;
		fixture.faux.setResponses([fixture.reply("three")]);
		await resumed.prompt("after resume");

		expect(toolNames(fixture.requests.at(-1)!)).not.toContain("mcp__docs__search");
		expect(toolChanges(resumed, before)).toEqual([{ added: [], removed: ["mcp__docs__search"] }]);
	});

	/** A copy of the stored session's transcript without the MCP tool records, as sessions saved before them are. */
	async function withoutRecords(fixture: Fixture, sessionFile: string, dir: string): Promise<string> {
		const stored = await SessionManager.open(sessionFile, undefined, fixture.cwd);
		const copy = await SessionManager.create(fixture.cwd, join(fixture.cwd, dir));
		for (const entry of stored.getBranch()) if (entry.type === "message") await copy.appendMessage(entry.message);
		return copy.getSessionFile()!;
	}

	it("declares a restored tool removed, as before, when the session has no record of it", async () => {
		const fixture = await createFixture();
		const { sessionFile } = await liveSession(fixture, { servers: { docs: { tools: [SEARCH], calls: [] } } });
		const unrecorded = await withoutRecords(fixture, sessionFile, "unrecorded");

		const resumed = await resume(fixture, unrecorded, {
			servers: { docs: { tools: [SEARCH], ready: held().ready, calls: [] } },
		});
		const before = resumed.messages.length;
		fixture.faux.setResponses([fixture.reply("three")]);
		await resumed.prompt("after resume");

		expect(toolNames(fixture.requests.at(-1)!)).not.toContain("mcp__docs__search");
		expect(toolChanges(resumed, before)).toEqual([{ added: [], removed: ["mcp__docs__search"] }]);
	});

	it("records the declared tools of a session without records once their server connects", async () => {
		const fixture = await createFixture();
		const { sessionFile, control } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
		});
		const unrecorded = await withoutRecords(fixture, sessionFile, "unrecorded");

		const inTime = await resume(fixture, unrecorded, { servers: { docs: { tools: [SEARCH], calls: [] } } });
		await vi.waitFor(() =>
			expect(
				inTime.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === MCP_TOOL_RECORD_ENTRY_TYPE),
			).toHaveLength(1),
		);
		await inTime.dispose();

		const slow = await resume(fixture, unrecorded, {
			servers: { docs: { tools: [SEARCH], ready: held().ready, calls: [] } },
		});
		const before = slow.messages.length;
		fixture.faux.setResponses([fixture.reply("three")]);
		await slow.prompt("after resume");
		expect(fixture.requests.at(-1)).toBe(control);
		expect(toolChanges(slow, before)).toEqual([]);
	});

	it("keeps declaring a tool that tool_search loaded while its server reconnects", async () => {
		const fixture = await createFixture();
		const manager = await SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
		const live = await startSession(fixture, manager, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
			exposure: "deferred",
		});
		await vi.waitFor(() => expect(live.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__search"));
		fixture.faux.setResponses([
			(context: Context) => {
				fixture.requests.push(flatTools(context));
				return fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
					stopReason: "toolUse",
				});
			},
			fixture.reply("loaded"),
		]);
		await live.prompt("load");
		const control = fixture.requests.at(-1)!;
		expect(toolNames(control)).toContain("mcp__docs__search");
		await live.dispose();

		const server = held();
		const script: ServerScript = { tools: [SEARCH], ready: server.ready, calls: [] };
		const resumed = await resume(fixture, manager.getSessionFile()!, {
			servers: { docs: script },
			exposure: "deferred",
		});
		const before = resumed.messages.length;
		const result = await promptCalling(fixture, resumed, "mcp__docs__search", () => server.release());

		expect(getMessageText(result)).toBe("again guide");
		expect(fixture.requests.slice(-2)).toEqual([control, control]);
		expect(toolChanges(resumed, before)).toEqual([]);
	});

	it("keeps each restored tool with its server when servers whose tool names collide reconnect in another order", async () => {
		const fixture = await createFixture();
		// `a` lists `b__c` and `a__b` lists `c`: both are named mcp__a__b__c, and only the first to register keeps it.
		const lookUp = (name: string): ListedTool => ({
			name,
			description: "Look up a term.",
			inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		});
		const later = held();
		const manager = await SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
		const live = await startSession(fixture, manager, {
			servers: {
				a: { tools: [lookUp("b__c")], calls: [] },
				a__b: { tools: [lookUp("c")], ready: later.ready, calls: [] },
			},
		});
		await vi.waitFor(() => expect(live.getActiveToolNames()).toContain("mcp__a__b__c"));
		later.release();
		await vi.waitFor(() =>
			expect(live.getActiveToolNames().filter((name) => name.startsWith("mcp__a__b__c"))).toHaveLength(2),
		);
		fixture.faux.setResponses([fixture.reply("one")]);
		await live.prompt("first");
		const control = fixture.requests.at(-1)!;
		await live.dispose();

		// This time `a__b` connects first, while `a` is still connecting.
		const slowA = held();
		const a: ServerScript = { tools: [lookUp("b__c")], ready: slowA.ready, calls: [] };
		const aB: ServerScript = { tools: [lookUp("c")], calls: [] };
		const resumed = await resume(fixture, manager.getSessionFile()!, { servers: { a, a__b: aB } });
		const before = resumed.messages.length;
		// `a__b` keeps the name it was declared under in the first process.
		const aBName = createMcpToolName("a__b", "c", (name) => name === "mcp__a__b__c");
		await vi.waitFor(() => expect(resumed.getAllTools().map((tool) => tool.name)).toContain(aBName));
		await promptCalling(fixture, resumed, "mcp__a__b__c", () => slowA.release());

		expect(a.calls).toEqual(["b__c"]);
		expect(aB.calls).toEqual([]);
		expect(fixture.requests.slice(-2)).toEqual([control, control]);
		expect(toolChanges(resumed, before)).toEqual([]);
	});

	it("keeps a server's recorded name when the tool that took the plain name was turned off", async () => {
		const fixture = await createFixture();
		const lookUp = (name: string): ListedTool => ({
			name,
			description: "Look up a term.",
			inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		});
		const later = held();
		const manager = await SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
		const live = await startSession(fixture, manager, {
			servers: {
				a: { tools: [lookUp("b__c")], calls: [] },
				a__b: { tools: [lookUp("c")], ready: later.ready, calls: [] },
			},
		});
		const aBName = createMcpToolName("a__b", "c", (name) => name === "mcp__a__b__c");
		await vi.waitFor(() => expect(live.getActiveToolNames()).toContain("mcp__a__b__c"));
		later.release();
		await vi.waitFor(() => expect(live.getActiveToolNames()).toContain(aBName));
		fixture.faux.setResponses([fixture.reply("one")]);
		await live.prompt("first");
		// The user turns `a`'s tool off; `a__b`'s keeps the hashed name it got when `a`'s had the plain one.
		live.setActiveToolsByName(live.getActiveToolNames().filter((name) => name !== "mcp__a__b__c"));
		fixture.faux.setResponses([fixture.reply("two")]);
		await live.prompt("second");
		const control = fixture.requests.at(-1)!;
		expect(toolNames(control)).toContain(aBName);
		expect(toolNames(control)).not.toContain("mcp__a__b__c");
		await live.dispose();

		// `a__b` connects first; `a` is still connecting.
		const a: ServerScript = { tools: [lookUp("b__c")], ready: held().ready, calls: [] };
		const aB: ServerScript = { tools: [lookUp("c")], calls: [] };
		const resumed = await resume(fixture, manager.getSessionFile()!, { servers: { a, a__b: aB } });
		const before = resumed.messages.length;
		await promptCalling(fixture, resumed, aBName);

		expect(aB.calls).toEqual(["c"]);
		expect(fixture.requests.slice(-2)).toEqual([control, control]);
		expect(toolChanges(resumed, before)).toEqual([]);
	});

	it("declares a server's tools in the same order however the server lists them", async () => {
		const fixture = await createFixture();
		const firstRequest = async (tools: ListedTool[], dir: string) => {
			const manager = await SessionManager.create(fixture.cwd, join(fixture.cwd, dir));
			const session = await startSession(fixture, manager, { servers: { docs: { tools, calls: [] } } });
			await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("mcp__docs__fetch"));
			fixture.faux.setResponses([fixture.reply("one")]);
			await session.prompt("first");
			await session.dispose();
			return fixture.requests.at(-1)!;
		};

		const listed = await firstRequest([SEARCH, FETCH], "listed");
		const reversed = await firstRequest([FETCH, SEARCH], "reversed");

		expect(toolNames(reversed).filter((name) => name.startsWith("mcp__"))).toEqual([
			"mcp__docs__fetch",
			"mcp__docs__search",
		]);
		expect(reversed).toBe(listed);
	});

	it("keeps declaring the resource tools while a direct server with resources reconnects", async () => {
		const fixture = await createFixture();
		const resources = [{ uri: "docs://guide", name: "guide" }];
		const { sessionFile, control } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], resources, calls: [] } },
		});
		expect(toolNames(control)).toEqual(expect.arrayContaining(["list_mcp_resources", "read_mcp_resource"]));

		const server = held();
		const script: ServerScript = { tools: [SEARCH], resources, ready: server.ready, calls: [] };
		const resumed = await resume(fixture, sessionFile, { servers: { docs: script } });
		const before = resumed.messages.length;
		const result = await promptCalling(fixture, resumed, "list_mcp_resources", () => setTimeout(server.release, 0), {
			server: "docs",
		});

		expect(getMessageText(result)).toContain("docs://guide");
		expect(script.calls).toEqual(["resources/list"]);
		expect(fixture.requests.slice(-2)).toEqual([control, control]);
		expect(toolChanges(resumed, before)).toEqual([]);
	});

	it("declares the resource tools removed once the only server with resources fails to reconnect", async () => {
		const fixture = await createFixture();
		const resources = [{ uri: "docs://guide", name: "guide" }];
		const { sessionFile, control } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], resources, calls: [] } },
		});

		const server = held();
		const resumed = await resume(fixture, sessionFile, {
			servers: { docs: { tools: [SEARCH], resources, ready: server.ready, calls: [] } },
		});
		const before = resumed.messages.length;
		fixture.faux.setResponses([fixture.reply("three")]);
		await resumed.prompt("after resume");
		expect(fixture.requests.at(-1)).toBe(control);

		server.fail(new Error("server crashed"));
		await vi.waitFor(() => expect(resumed.getActiveToolNames()).not.toContain("list_mcp_resources"));
		fixture.faux.setResponses([fixture.reply("four")]);
		await resumed.prompt("after the failure");
		expect(toolChanges(resumed, before)).toEqual([
			{
				added: [],
				removed: ["list_mcp_resource_templates", "list_mcp_resources", "mcp__docs__search", "read_mcp_resource"],
			},
		]);
	});
});
