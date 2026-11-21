import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, getCurrentSystemMessage, resolveTranscriptTools } from "@bastani/atomic-ai";
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
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../src/core/models-store.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import {
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAuthRequiredError,
} from "../../src/extensions/mcp/client/index.ts";
import { createInMemoryTransportPair } from "../../src/extensions/mcp/client/testing/index.ts";
import type { McpExposure, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension, MCP_SERVERS_SECTION } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";
import {
	MCP_TOOL_RECORD_ENTRY_TYPE,
	readToolRecords,
	transportFingerprint,
} from "../../src/extensions/mcp/tool-records.ts";
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
	/** The instructions the server sends with its `initialize` answer. */
	instructions?: string;
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
					...(script.instructions === undefined ? {} : { instructions: script.instructions }),
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
		/** Servers started as a command instead of a URL, by server name. */
		commands?: Record<string, { command: string; args?: string[] }>;
		/** Configured descriptions, by server name. */
		descriptions?: Record<string, string>;
		/** Extensions loaded after the MCP integration. */
		extensions?: ExtensionFactory[];
		/** Where each server is defined, by server name; none by default. */
		scopes?: Record<string, "global" | "project">;
		/** Project `mcp.json` overrides of global servers, by server name. */
		overrides?: Record<string, string>;
		/** The servers `mcp.json` defines; all of them by default. The others are for extensions to register. */
		configured?: string[];
		/** `toolExposure` of every server: the exposure of single tools that differs from the server's. */
		toolExposure?: Record<string, McpExposure>;
	}

	/** What `atomic --resume` does for a stored session: file-backed manager, the MCP servers from mcp.json, same model. */
	async function startSession(fixture: Fixture, sessionManager: SessionManager, options: StartOptions) {
		const settingsManager = SettingsManager.inMemory();
		const entries: McpServerEntry[] = (options.configured ?? Object.keys(options.servers)).map((name) => ({
			name,
			config: {
				...(options.commands?.[name] ?? { url: options.urls?.[name] ?? `http://${name}.invalid/mcp` }),
				exposure: options.exposure ?? "direct",
				...(options.toolExposure ? { toolExposure: options.toolExposure } : {}),
				...(options.descriptions?.[name] === undefined ? {} : { description: options.descriptions[name] }),
			},
			source: "test",
			...(options.scopes?.[name] === undefined ? {} : { scope: options.scopes[name] }),
			...(options.overrides?.[name] === undefined ? {} : { override: options.overrides[name] }),
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
				...(options.extensions ?? []),
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

	it("fingerprints a server URL by its scheme, host, port and path only", () => {
		const fingerprint = (url: string) => transportFingerprint({ name: "docs", config: { url }, source: "test" });
		const bare = fingerprint("https://mcp.example.com:8443/v1/mcp");

		expect(fingerprint("https://user:pass@mcp.example.com:8443/v1/mcp?api_key=sk-secret#top")).toBe(bare);
		expect(fingerprint("https://mcp.example.com:8443/v1/mcp?api_key=another")).toBe(bare);
		for (const other of [
			"http://mcp.example.com:8443/v1/mcp",
			"https://other.example.com:8443/v1/mcp",
			"https://mcp.example.com:9443/v1/mcp",
			"https://mcp.example.com:8443/v2/mcp",
		]) {
			expect(fingerprint(other)).not.toBe(bare);
		}
		// A URL that is not one until its placeholders are filled in loses the same parts.
		expect(fingerprint(`\${MCP_URL}?api_key=\${MCP_KEY}`)).toBe(fingerprint(`\${MCP_URL}`));
	});

	it("stores nothing derived from a server URL's credentials or query in the session", async () => {
		const fixture = await createFixture();
		const url = "http://user:pass@docs.invalid/mcp?api_key=sk-secret-6094";
		const { sessionFile } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
			urls: { docs: url },
		});

		const stored = readFileSync(sessionFile, "utf8");
		const records = stored
			.split("\n")
			.filter((line) => line.includes(MCP_TOOL_RECORD_ENTRY_TYPE))
			.map((line) => JSON.parse(line) as { data: { tools: { transport: string }[] } });
		expect(records.map((record) => record.data.tools.map((tool) => tool.transport))).toEqual([
			[transportFingerprint({ name: "docs", config: { url: "http://docs.invalid/mcp" }, source: "test" })],
		]);
		const hashes = (text: string) => {
			const hex = createHash("sha256").update(text).digest("hex");
			return [hex, hex.slice(0, 16)];
		};
		for (const secret of [url, JSON.stringify({ url }), "api_key=sk-secret-6094", "sk-secret-6094", "user:pass"]) {
			expect(stored).not.toContain(secret);
			for (const hash of hashes(secret)) expect(stored).not.toContain(hash);
		}
	});

	/** The `mcp_servers` section of every prompt update after `from`, in order. */
	function sectionUpdates(session: AgentSession, from: number): (string | null)[] {
		return session.messages
			.slice(from)
			.flatMap((message) =>
				message.role === "system" && message.sections && MCP_SERVERS_SECTION in message.sections
					? [message.sections[MCP_SERVERS_SECTION] ?? null]
					: [],
			);
	}

	/** The `mcp_servers` section the model has now. */
	function currentSection(session: AgentSession): string | undefined {
		return getCurrentSystemMessage(session.messages)?.sections?.[MCP_SERVERS_SECTION];
	}

	/** Wait until every server's connection attempt settled: `/mcp` without a terminal waits for them. */
	async function settled(session: AgentSession): Promise<void> {
		await session.prompt("/mcp");
	}

	/** The server lines of an `mcp_servers` section. */
	function serverLines(section: string | null | undefined): string[] {
		return (section ?? "").split("\n").filter((line) => line.startsWith("- "));
	}

	const DOCS_INSTRUCTIONS = "Search and fetch the product docs.\nCall search before fetch.";
	const docsLine = (summary?: string) => `- mcp__docs (codemode)${summary ? `: ${summary}` : ""}`;

	/** A first process whose prompts list the codemode servers once connected; it quits after two prompts. */
	async function liveCodemodeSession(fixture: Fixture, options: StartOptions) {
		const manager = await SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
		const live = await startSession(fixture, manager, { exposure: "codemode", ...options });
		await settled(live);
		fixture.faux.setResponses([fixture.reply("one")]);
		await live.prompt("first");
		fixture.faux.setResponses([fixture.reply("two")]);
		await live.prompt("second");
		const section = currentSection(live);
		await live.dispose();
		return { sessionFile: manager.getSessionFile()!, section };
	}

	async function promptReply(fixture: Fixture, session: AgentSession, text: string) {
		fixture.faux.setResponses([fixture.reply(text)]);
		await session.prompt(text);
	}

	it("keeps a reconnecting server's summary in the mcp_servers section of a resumed session (#6108)", async () => {
		const fixture = await createFixture();
		const { sessionFile, section } = await liveCodemodeSession(fixture, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, calls: [] } },
		});
		expect(serverLines(section)).toEqual([docsLine("Search and fetch the product docs.")]);

		const server = held();
		const resumed = await resume(fixture, sessionFile, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, ready: server.ready, calls: [] } },
			exposure: "codemode",
		});
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "after resume");
		expect(sectionUpdates(resumed, before)).toEqual([]);

		server.release();
		await settled(resumed);
		await promptReply(fixture, resumed, "after reconnect");
		expect(sectionUpdates(resumed, before)).toEqual([]);
		expect(currentSection(resumed)).toBe(section);
	});

	it("drops a recorded server summary once the server fails to reconnect (#6108)", async () => {
		const fixture = await createFixture();
		const { sessionFile, section } = await liveCodemodeSession(fixture, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, calls: [] } },
		});

		const server = held();
		const resumed = await resume(fixture, sessionFile, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, ready: server.ready, calls: [] } },
			exposure: "codemode",
		});
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "after resume");
		expect(sectionUpdates(resumed, before)).toEqual([]);

		server.fail(new Error("server crashed"));
		await settled(resumed);
		await promptReply(fixture, resumed, "after the failure");
		expect(sectionUpdates(resumed, before)).toEqual([
			section?.replace(docsLine("Search and fetch the product docs."), docsLine()),
		]);
	});

	it.each([
		{
			change: "other instructions",
			instructions: "Search the docs, version 2.",
			line: docsLine("Search the docs, version 2."),
		},
		{ change: "no instructions", instructions: undefined, line: docsLine() },
	])(
		"shows what a reconnected server sends when it sends $change, and keeps that at the next resume (#6108)",
		async ({ instructions, line }) => {
			const fixture = await createFixture();
			const { sessionFile, section } = await liveCodemodeSession(fixture, {
				servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, calls: [] } },
			});

			const server = held();
			const resumed = await resume(fixture, sessionFile, {
				servers: { docs: { tools: [SEARCH], instructions, ready: server.ready, calls: [] } },
				exposure: "codemode",
			});
			const before = resumed.messages.length;
			await promptReply(fixture, resumed, "after resume");
			expect(sectionUpdates(resumed, before)).toEqual([]);
			server.release();
			await settled(resumed);
			await promptReply(fixture, resumed, "after reconnect");
			const changed = section?.replace(docsLine("Search and fetch the product docs."), line);
			expect(sectionUpdates(resumed, before)).toEqual([changed]);
			await resumed.dispose();

			// The next resume shows what the server sent last while it reconnects again.
			const again = held();
			const third = await resume(fixture, sessionFile, {
				servers: { docs: { tools: [SEARCH], instructions, ready: again.ready, calls: [] } },
				exposure: "codemode",
			});
			const start = third.messages.length;
			await promptReply(fixture, third, "after the second resume");
			again.release();
			await settled(third);
			await promptReply(fixture, third, "after the second reconnect");
			expect(sectionUpdates(third, start)).toEqual([]);
			expect(currentSection(third)).toBe(changed);
		},
	);

	it.each([
		{
			change: "now has a description",
			options: { descriptions: { docs: "Product docs." } },
			line: docsLine("Product docs."),
		},
		{
			change: "now points to another URL",
			options: { urls: { docs: "http://elsewhere.invalid/mcp" } },
			line: docsLine(),
		},
		{
			change: "is now started as a command",
			options: { commands: { docs: { command: "docs-server" } } },
			line: docsLine(),
		},
	])("does not show a recorded summary for a server that $change (#6108)", async ({ options, line }) => {
		const fixture = await createFixture();
		const { sessionFile } = await liveCodemodeSession(fixture, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, calls: [] } },
		});

		const resumed = await resume(fixture, sessionFile, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, ready: held().ready, calls: [] } },
			exposure: "codemode",
			...options,
		});
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "after resume");
		expect(sectionUpdates(resumed, before).map((update) => serverLines(update))).toEqual([[line]]);
	});

	/** The summaries the session's records hold, in the order they were recorded. */
	function recordedSummaries(stored: string): { server: string; summary: string }[] {
		return stored
			.split("\n")
			.filter((line) => line.includes(MCP_TOOL_RECORD_ENTRY_TYPE))
			.flatMap(
				(line) =>
					(JSON.parse(line) as { data: { summaries?: { server: string; summary: string }[] } }).data.summaries ??
					[],
			);
	}

	it("records each server's summary once, as the section shows it (#6108)", async () => {
		const fixture = await createFixture();
		// Enough servers that each summary gets less room than the most the section gives one (250 characters).
		const names = Array.from({ length: 20 }, (_, index) => `docs${index}`);
		const firstLine = (index: number) =>
			`Docs ${index}: ${"search and fetch the product docs, ".repeat(6)}hidden-6108 ${"and more ".repeat(20)}`.trim();
		const script = (index: number, ready?: Promise<unknown>): ServerScript => ({
			tools: [],
			instructions: `${firstLine(index)}\nSecond line of docs ${index}.`,
			...(ready ? { ready } : {}),
			calls: [],
		});
		const { sessionFile, section } = await liveCodemodeSession(fixture, {
			servers: Object.fromEntries(names.map((name, index) => [name, script(index)])),
		});
		const lines = serverLines(section);
		expect(lines).toHaveLength(20);
		expect(section).not.toContain("hidden-6108");

		const stored = readFileSync(sessionFile, "utf8");
		const recorded = recordedSummaries(stored);
		expect(recorded.map((record) => `- mcp__${record.server} (codemode): ${record.summary}`).sort()).toEqual(
			[...lines].sort(),
		);
		expect(stored).not.toContain("hidden-6108");
		expect(stored).not.toContain("Second line of docs");

		const ready = held();
		const resumed = await resume(fixture, sessionFile, {
			servers: Object.fromEntries(names.map((name, index) => [name, script(index, ready.ready)])),
			exposure: "codemode",
		});
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "after resume");
		ready.release();
		await settled(resumed);
		await promptReply(fixture, resumed, "after reconnect");
		expect(sectionUpdates(resumed, before)).toEqual([]);
		expect(currentSection(resumed)).toBe(section);
		await resumed.dispose();
		expect(recordedSummaries(readFileSync(sessionFile, "utf8"))).toHaveLength(20);
	});

	it.each([
		{ room: "as much room", count: 146, options: {}, updates: [] },
		{ room: "less room", count: 147, options: { descriptions: { s146: "z" } }, updates: [docsLine()] },
		{
			room: "less room and a configured description",
			count: 147,
			options: { descriptions: { s146: "z", docs: "Q" } },
			updates: [docsLine("Q")],
		},
	])(
		"records a summary cut down to its ellipsis, and resumed with $room shows what the server would (#6108)",
		async ({ count, options, updates }) => {
			const fixture = await createFixture();
			// With this many servers each summary gets two characters, and one once another server is added.
			const others = (total: number, ready?: Promise<unknown>) =>
				Object.fromEntries(
					Array.from({ length: total }, (_, index): [string, ServerScript] => [
						`s${String(index).padStart(3, "0")}`,
						{ tools: [], instructions: "z", ...(ready ? { ready } : {}), calls: [] },
					]),
				);
			const docs = (ready?: Promise<unknown>): ServerScript => ({
				tools: [],
				instructions: "🧾 Docs.",
				...(ready ? { ready } : {}),
				calls: [],
			});
			const { sessionFile, section } = await liveCodemodeSession(fixture, {
				servers: { ...others(146), docs: docs() },
			});
			expect(serverLines(section)).toContain(docsLine("…"));

			// An added server has a configured description, so its line is complete at once.
			const ready = held();
			const resumed = await resume(fixture, sessionFile, {
				servers: { ...others(count, ready.ready), docs: docs(ready.ready) },
				exposure: "codemode",
				...options,
			});
			const before = resumed.messages.length;
			await promptReply(fixture, resumed, "after resume");
			ready.release();
			await settled(resumed);
			await promptReply(fixture, resumed, "after reconnect");
			const sent = sectionUpdates(resumed, before);
			expect(sent).toHaveLength(updates.length);
			for (const [index, line] of updates.entries()) expect(serverLines(sent[index])).toContain(line);
		},
	);

	it("keeps no summary in memory for a server whose latest summary record is empty (#6108)", () => {
		const entry = (id: string, summaries: { server: string; summary: string }[]): SessionEntry =>
			({
				type: "custom",
				id,
				parentId: null,
				timestamp: "2026-11-21T00:00:00.000Z",
				customType: MCP_TOOL_RECORD_ENTRY_TYPE,
				data: { tools: [], summaries: summaries.map((record) => ({ ...record, transport: "t", scope: null })) },
			}) as SessionEntry;
		const records = readToolRecords([
			entry("a", [
				{ server: "docs", summary: "Search the docs." },
				{ server: "wiki", summary: "Search the wiki." },
			]),
			entry("b", [{ server: "docs", summary: "" }]),
		]);
		expect([...records.summaries.keys()]).toEqual(["wiki"]);
	});

	it("records the tools a prompt declares together with the summary its section shows (#6108)", async () => {
		const fixture = await createFixture();
		// The server is listed in the section for codemode and its tools are declared directly.
		const options = {
			exposure: "codemode" as const,
			toolExposure: { search: "direct" as const, fetch: "direct" as const },
		};
		const script = (ready?: Promise<unknown>): ServerScript => ({
			tools: [SEARCH, FETCH],
			instructions: DOCS_INSTRUCTIONS,
			...(ready ? { ready } : {}),
			calls: [],
		});
		const { sessionFile, control } = await liveSession(fixture, { servers: { docs: script() }, ...options });
		expect(toolNames(control)).toEqual(expect.arrayContaining(["mcp__docs__fetch", "mcp__docs__search"]));
		expect(recordedSummaries(readFileSync(sessionFile, "utf8")).map((record) => record.server)).toEqual(["docs"]);

		const server = held();
		const resumed = await resume(fixture, sessionFile, { servers: { docs: script(server.ready) }, ...options });
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "after resume");
		expect(fixture.requests.at(-1)).toBe(control);
		server.release();
		await settled(resumed);
		await promptReply(fixture, resumed, "after reconnect");
		expect(fixture.requests.at(-1)).toBe(control);
		expect(toolChanges(resumed, before)).toEqual([]);
		expect(sectionUpdates(resumed, before)).toEqual([]);
	});

	it("records a summary for the server that showed it, not for one registered under its name meanwhile (#6108)", async () => {
		const fixture = await createFixture();
		const registration = { command: "docs-a", replaceWith: undefined as string | undefined };
		const registering: ExtensionFactory = (pi) => {
			pi.registerMcpServer("docs", { command: registration.command, exposure: "codemode" });
			pi.on("before_agent_start", () => {
				if (registration.replaceWith)
					pi.registerMcpServer("docs", { command: registration.replaceWith, exposure: "codemode" });
			});
		};
		const manager = await SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
		const live = await startSession(fixture, manager, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, calls: [] } },
			configured: [],
			exposure: "codemode",
			extensions: [registering],
		});
		await settled(live);
		// The prompt's section shows docs-a's summary; a later handler then registers docs-b under the same name.
		registration.replaceWith = "docs-b";
		await promptReply(fixture, live, "first");
		expect(serverLines(currentSection(live))).toEqual([docsLine("Search and fetch the product docs.")]);
		await live.dispose();

		registration.command = "docs-b";
		registration.replaceWith = undefined;
		const resumed = await resume(fixture, manager.getSessionFile()!, {
			servers: { docs: { tools: [SEARCH], instructions: "Other docs.", ready: held().ready, calls: [] } },
			configured: [],
			exposure: "codemode",
			extensions: [registering],
		});
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "after resume");
		expect(sectionUpdates(resumed, before).map((update) => serverLines(update))).toEqual([[docsLine()]]);
	});

	it("records no summary the conversation never showed (#6108)", async () => {
		const fixture = await createFixture();
		const replaceSection: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.sections[MCP_SERVERS_SECTION] = "The application lists its own servers.";
			});
		};
		const { sessionFile, section } = await liveCodemodeSession(fixture, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, calls: [] } },
			extensions: [replaceSection],
		});
		expect(section).toContain("The application lists its own servers.");

		const stored = readFileSync(sessionFile, "utf8");
		expect(recordedSummaries(stored)).toEqual([]);
		expect(stored).not.toContain("Search and fetch the product docs.");
	});

	it("records no summary of a prompt that ended before it sent anything (#6108)", async () => {
		const fixture = await createFixture();
		const gate = { held: undefined as ReturnType<typeof held> | undefined, entered: held() };
		const holdPrompt: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", async () => {
				if (!gate.held) return;
				gate.entered.release();
				await gate.held.ready;
			});
		};
		const server = held();
		const manager = await SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
		const live = await startSession(fixture, manager, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, ready: server.ready, calls: [] } },
			exposure: "codemode",
			extensions: [holdPrompt],
		});
		await promptReply(fixture, live, "first");
		const section = currentSection(live);
		expect(serverLines(section)).toEqual([docsLine()]);
		server.release();
		await settled(live);
		// The next prompt shows the summary, but the session closes before the prompt sends anything.
		gate.held = held();
		const prompt = live.prompt("closed before it was sent").catch(() => undefined);
		await gate.entered.ready;
		const disposed = live.dispose();
		gate.held.release();
		await Promise.all([prompt, disposed]);
		expect(recordedSummaries(readFileSync(manager.getSessionFile()!, "utf8"))).toEqual([]);

		const resumed = await resume(fixture, manager.getSessionFile()!, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, ready: held().ready, calls: [] } },
			exposure: "codemode",
		});
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "after resume");
		expect(sectionUpdates(resumed, before)).toEqual([]);
		expect(currentSection(resumed)).toBe(section);
	});

	const stdio = (args: string[]) => ({ docs: { command: "docs-server", args } });

	it("keeps a resumed session's tools declared when a stdio server's token argument changed (#6109)", async () => {
		const fixture = await createFixture();
		const { sessionFile, control } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
			commands: stdio(["--token", "abc"]),
		});

		const server = held();
		const resumed = await resume(fixture, sessionFile, {
			servers: { docs: { tools: [SEARCH], ready: server.ready, calls: [] } },
			commands: stdio(["--token", "def"]),
		});
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "after resume");
		expect(fixture.requests.at(-1)).toBe(control);
		server.release();
		await settled(resumed);
		await promptReply(fixture, resumed, "after reconnect");
		expect(fixture.requests.at(-1)).toBe(control);
		expect(toolChanges(resumed, before)).toEqual([]);
	});

	it("stores nothing derived from a stdio server's arguments in the session (#6109)", async () => {
		const fixture = await createFixture();
		const args = ["--api-key", "sk-secret-6109", "--token=tok-6109", "positional-6109"];
		const { sessionFile } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
			commands: stdio(args),
		});

		const stored = readFileSync(sessionFile, "utf8");
		const transports = stored
			.split("\n")
			.filter((line) => line.includes(MCP_TOOL_RECORD_ENTRY_TYPE))
			.flatMap((line) => (JSON.parse(line) as { data: { tools: { transport: string }[] } }).data.tools)
			.map((tool) => tool.transport);
		// The fingerprint of `docs-server` without arguments, as 0.10.2 recorded it.
		expect(transports).toEqual(["4bc6c60d855bcca8"]);
		const hashes = (text: string) => {
			const hex = createHash("sha256").update(text).digest("hex");
			return [hex, hex.slice(0, 16)];
		};
		for (const secret of [JSON.stringify({ command: "docs-server", args }), JSON.stringify(args), ...args]) {
			expect(stored).not.toContain(secret);
			for (const hash of hashes(secret)) expect(stored).not.toContain(hash);
		}
	});

	/** A copy of the stored session whose tool records carry `transport` and no scope, as 0.10.2 recorded them. */
	async function withTransport(fixture: Fixture, sessionFile: string, transport: string): Promise<string> {
		const stored = await SessionManager.open(sessionFile, undefined, fixture.cwd);
		const copy = await SessionManager.create(fixture.cwd, join(fixture.cwd, "earlier"));
		for (const entry of stored.getBranch()) {
			if (entry.type === "message") await copy.appendMessage(entry.message);
			else if (entry.type === "custom" && entry.customType === MCP_TOOL_RECORD_ENTRY_TYPE) {
				const data = entry.data as { tools: { transport: string; scope?: string | null }[] };
				await copy.appendCustomEntry(MCP_TOOL_RECORD_ENTRY_TYPE, {
					...data,
					tools: data.tools.map(({ scope: _scope, ...tool }) => ({ ...tool, transport })),
				});
			}
		}
		return copy.getSessionFile()!;
	}

	it.each([
		{ args: ["--token", "abc"], kept: true },
		{ args: ["--token", "def"], kept: false },
	])(
		"restores the tools a 0.10.2 session recorded for a stdio server only with the same arguments (#6109): $args",
		async ({ args, kept }) => {
			const fixture = await createFixture();
			const { sessionFile, control } = await liveSession(fixture, {
				servers: { docs: { tools: [SEARCH], calls: [] } },
				commands: stdio(["--token", "abc"]),
			});
			// 0.10.2 hashed `{"command":"docs-server","args":["--token","abc"]}`.
			const earlier = await withTransport(fixture, sessionFile, "c0879d833ebf5879");

			const resumed = await resume(fixture, earlier, {
				servers: { docs: { tools: [SEARCH], ready: held().ready, calls: [] } },
				commands: stdio(args),
			});
			const before = resumed.messages.length;
			await promptReply(fixture, resumed, "after resume");
			if (kept) {
				expect(fixture.requests.at(-1)).toBe(control);
				expect(toolChanges(resumed, before)).toEqual([]);
			} else {
				expect(toolChanges(resumed, before)).toEqual([{ added: [], removed: ["mcp__docs__search"] }]);
			}
		},
	);

	it.each([
		{
			change: "is now defined globally, as when the project is no longer trusted",
			kept: false,
			options: { scopes: { docs: "global" as const } },
		},
		{
			change: "keeps its global definition with a project override",
			kept: true,
			options: { scopes: { docs: "global" as const }, overrides: { docs: "project mcp.json" } },
		},
	])(
		"keeps the recorded tools of a server that $change only for the same definition (#6109)",
		async ({ kept, options }) => {
			const fixture = await createFixture();
			const first = kept ? { scopes: { docs: "global" as const } } : { scopes: { docs: "project" as const } };
			const { sessionFile, control } = await liveSession(fixture, {
				servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, calls: [] } },
				commands: stdio(["--package", "project-docs"]),
				...first,
			});

			const resumed = await resume(fixture, sessionFile, {
				servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, ready: held().ready, calls: [] } },
				commands: stdio(kept ? ["--package", "project-docs"] : ["--package", "global-docs"]),
				...options,
			});
			const before = resumed.messages.length;
			await promptReply(fixture, resumed, "after resume");
			if (kept) {
				expect(fixture.requests.at(-1)).toBe(control);
				expect(toolChanges(resumed, before)).toEqual([]);
			} else {
				expect(toolChanges(resumed, before)).toEqual([{ added: [], removed: ["mcp__docs__search"] }]);
			}
		},
	);

	it("does not show the recorded summary of a project's server for a global server of the same name (#6108)", async () => {
		const fixture = await createFixture();
		const { sessionFile } = await liveCodemodeSession(fixture, {
			servers: { docs: { tools: [SEARCH], instructions: DOCS_INSTRUCTIONS, calls: [] } },
			commands: stdio(["--package", "project-docs"]),
			scopes: { docs: "project" },
		});

		const resumed = await resume(fixture, sessionFile, {
			servers: { docs: { tools: [SEARCH], instructions: "Global docs.", ready: held().ready, calls: [] } },
			exposure: "codemode",
			commands: stdio(["--package", "global-docs"]),
			scopes: { docs: "global" },
		});
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "after resume");
		expect(sectionUpdates(resumed, before).map((update) => serverLines(update))).toEqual([[docsLine()]]);
	});

	it("brings a 0.10.2 session's records up to date, so a token argument added later keeps the tools (#6109)", async () => {
		const fixture = await createFixture();
		const { sessionFile, control } = await liveSession(fixture, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
			commands: stdio([]),
		});
		// 0.10.2 hashed `{"command":"docs-server","args":[]}` and recorded no scope.
		const earlier = await withTransport(fixture, sessionFile, "4bc6c60d855bcca8");

		const upgraded = await resume(fixture, earlier, {
			servers: { docs: { tools: [SEARCH], calls: [] } },
			commands: stdio([]),
		});
		await settled(upgraded);
		await promptReply(fixture, upgraded, "after the upgrade");
		await upgraded.dispose();

		const resumed = await resume(fixture, earlier, {
			servers: { docs: { tools: [SEARCH], ready: held().ready, calls: [] } },
			commands: stdio(["--token", "abc"]),
		});
		const before = resumed.messages.length;
		await promptReply(fixture, resumed, "with a token");
		expect(fixture.requests.at(-1)).toBe(control);
		expect(toolChanges(resumed, before)).toEqual([]);
	});

	it("keeps the fingerprints 0.10.2 recorded for URL servers and for commands without arguments (#6109)", () => {
		expect(
			transportFingerprint({ name: "docs", config: { url: "https://mcp.example.com:8443/v1/mcp" }, source: "test" }),
		).toBe("51c7cf36bf9e812c");
		expect(transportFingerprint({ name: "docs", config: { command: "docs-server" }, source: "test" })).toBe(
			"4bc6c60d855bcca8",
		);
	});
});
