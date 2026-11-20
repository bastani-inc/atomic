import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { parseArgs } from "../src/cli/args.js";
import { getDocsPath, getExamplesPath, getPackageDir } from "../src/config.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../src/core/agent-session-runtime.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { SessionManager } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import type { ExtensionFactory } from "../src/index.js";
import { openCliSession } from "../src/main-session.js";
import {
	type AnthropicRequestBody,
	cacheMarkers,
	RecordingAnthropicServer,
	withoutCacheMarkers,
} from "./helpers/recording-anthropic-server.js";

/**
 * A resume must be a no-op for the provider's prompt cache: the first request after it is the request a session that
 * kept running would have sent, so it reuses everything the last request before the exit cached. Each test runs the
 * same conversation twice against a local endpoint that records the serialized requests: once in one session that
 * keeps running (the control), and once exiting and resuming at the same point through a real resume path.
 */

useTemporaryAgentDir();

/** Claude models whose endpoint accepts later system messages and tool changes in place, and one that does not. */
const NATIVE_MODEL = "claude-opus-5-5";
const FLAT_MODEL = "claude-sonnet-4-6";
/** A Claude model that thinks within a fixed token budget. */
const BUDGET_MODEL = "claude-sonnet-4-5";

let sandbox: GitSandbox;
let server: RecordingAnthropicServer;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
	sandbox = new GitSandbox();
	server = await RecordingAnthropicServer.start();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	await server.close();
	sandbox.dispose();
});

interface Installation {
	agentDir: string;
	cwd: string;
	store: SessionStore;
	createRuntime: CreateAgentSessionRuntimeFactory;
}

/** Calls of the `wait_tool` extension tool finish when this is resolved, or when they are aborted. */
let releaseWaitTool: () => void = () => {};
let waitToolCalls = 0;

interface InstallOptions {
	/** Names of extension tools, registered in this order once the session starts. */
	tools?: () => readonly string[];
	/** Load the bundled packages (subagents, MCP, web access) too. */
	builtins?: boolean;
	/** More extensions to load. */
	factories?: ExtensionFactory[];
	settings?: Record<string, unknown>;
}

/** An agent directory whose Anthropic provider is the recording endpoint, and a project with an AGENTS.md. */
async function install(model: string, name = "install", options: InstallOptions = {}): Promise<Installation> {
	const agentDir = sandbox.path(name, "agent");
	const cwd = sandbox.path(name, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { anthropic: { baseUrl: server.baseUrl } } }),
	);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-test" } }));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "anthropic",
			defaultModel: model,
			defaultThinkingLevel: "off",
			...options.settings,
		}),
	);
	writeFileSync(join(cwd, "AGENTS.md"), "Prefer small changes.\n");
	const store = await openStore(cwd, agentDir, join(agentDir, "sessions"));
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				...(options.builtins ? {} : { builtinPackagePaths: [] }),
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					...(options.tools ? [extensionTools(options.tools)] : []),
					...(options.factories ?? []),
				],
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	return { agentDir, cwd, store, createRuntime };
}

/** A session store in `dir`, one file per session, so a test can copy what a crashed process left behind. */
async function openStore(cwd: string, agentDir: string, dir: string): Promise<SessionStore> {
	const store = await resolveSessionStore(cwd, { agentDir, sessionStore: { kind: "jsonl", dir } });
	cleanups.push(() => store.close());
	return store;
}

/** An extension registering tools named by `names()` when a session starts, in that order. */
function extensionTools(names: () => readonly string[]): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", () => {
			for (const name of names())
				pi.registerTool({
					name,
					label: name,
					description: `The ${name} tool`,
					parameters: Type.Object({ value: Type.String() }),
					execute: async (_id, _input, signal) => {
						if (name === "wait_tool")
							await new Promise<void>((resolve) => {
								waitToolCalls++;
								releaseWaitTool = resolve;
								signal?.addEventListener("abort", () => resolve(), { once: true });
							});
						return { content: [{ type: "text", text: `${name} done` }], details: {} };
					},
				});
		});
	};
}

async function start(installation: Installation, sessionManager?: SessionManager): Promise<AgentSessionRuntime> {
	const runtime = await createAgentSessionRuntime(installation.createRuntime, {
		cwd: installation.cwd,
		agentDir: installation.agentDir,
		sessionManager: sessionManager ?? (await SessionManager.create(installation.store, installation.cwd)),
	});
	cleanups.push(() => runtime.dispose());
	return runtime;
}

/** The conversation request a prompt sent: the last request recorded while it ran. */
async function send(runtime: AgentSessionRuntime, text: string): Promise<AnthropicRequestBody> {
	const before = server.requests.length;
	await runtime.session.prompt(text);
	assert.ok(
		server.requests.length > before,
		`"${text}" sent no request: ${runtime.session.model?.provider}/${runtime.session.model?.id} ${JSON.stringify(runtime.session.messages.at(-1))}`,
	);
	return server.requests.at(-1)!.json;
}

/** Opens the session as `atomic <flags>` does, through the CLI's resume path. */
async function openWithFlags(installation: Installation, flags: string[]): Promise<SessionManager> {
	const opened = await openCliSession(parseArgs(flags), installation.cwd, SettingsManager.inMemory(), {
		agentDir: installation.agentDir,
		sessionStorage: installation.store,
		trusted: () => true,
		claim: false,
	});
	assert.notEqual(opened, "cancelled");
	if (opened === "cancelled") throw new Error("unreachable");
	return opened.sessionManager;
}

/** The fields of a request other than its messages as JSON text, and its messages, without the markers that move. */
function split(request: AnthropicRequestBody) {
	const { messages, ...settings } = withoutCacheMarkers(request);
	return { settings: JSON.stringify(settings), messages: messages.map((message) => JSON.stringify(message)) };
}

/**
 * `after` reuses everything `before` cached: the same tools, system prompt and settings, and `before`'s messages up to
 * its last cache breakpoint as its start.
 */
function assertExtends(before: AnthropicRequestBody, after: AnthropicRequestBody): void {
	const earlier = split(before);
	const later = split(after);
	assert.equal(later.settings, earlier.settings);
	const cached = (cacheMarkers(before).at(-1)?.[0] ?? -1) + 1;
	assert.ok(cached > 0, "the request before had no cache breakpoint");
	assert.deepEqual(later.messages.slice(0, cached), earlier.messages.slice(0, cached));
}

async function until(condition: () => boolean): Promise<void> {
	for (let waited = 0; !condition(); waited += 10) {
		if (waited > 20_000) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * The stored session `runtime` runs, as a new process finds it after `runtime`'s process died: a copy of the store taken
 * now, opened by another runtime, while `runtime` goes on writing only to the original.
 */
async function openAfterCrash(installation: Installation, runtime: AgentSessionRuntime): Promise<AgentSessionRuntime> {
	const sessionId = runtime.session.sessionManager.getSessionId();
	const copy = sandbox.path(`after-crash-${server.requests.length}`);
	cpSync(join(installation.agentDir, "sessions"), copy, { recursive: true });
	const store = await openStore(installation.cwd, installation.agentDir, copy);
	return start(installation, await SessionManager.open(store, sessionId, installation.cwd));
}

/** The first request after the resume is the request the control sent at the same point. */
function assertSameAsControl(control: AnthropicRequestBody, resumed: AnthropicRequestBody): void {
	assert.equal(JSON.stringify(withoutCacheMarkers(resumed)), JSON.stringify(withoutCacheMarkers(control)));
}

type Reopen = (installation: Installation, sessionId: string) => Promise<AgentSessionRuntime>;

const resumePaths: Array<[string, Reopen]> = [
	[
		"--session <id>, as the isolated engine also starts",
		async (installation, sessionId) =>
			start(installation, await openWithFlags(installation, ["--session", sessionId])),
	],
	["--continue", async (installation) => start(installation, await openWithFlags(installation, ["--continue"]))],
	[
		"/resume from another session",
		async (installation, sessionId) => {
			const runtime = await start(installation);
			await runtime.switchSession(sessionId);
			return runtime;
		},
	],
	[
		"a runtime restarted on the stored session",
		async (installation, sessionId) =>
			start(installation, await SessionManager.open(installation.store, sessionId, installation.cwd)),
	],
];

describe("the first request after a resume is the request a session that kept running sends", () => {
	for (const model of [NATIVE_MODEL, FLAT_MODEL]) {
		for (const [path, reopen] of resumePaths) {
			test(`${model}: ${path}`, async () => {
				const installation = await install(model);
				const control = await start(installation);
				await send(control, "one");
				await send(control, "two");
				const controlThird = await send(control, "three");
				await control.dispose();

				const live = await start(installation);
				await send(live, "one");
				const lastBeforeExit = await send(live, "two");
				const sessionId = live.session.sessionManager.getSessionId();
				await live.dispose();

				const resumed = await reopen(installation, sessionId);
				const firstAfterResume = await send(resumed, "three");

				assertExtends(lastBeforeExit, firstAfterResume);
				assertSameAsControl(controlThird, firstAfterResume);
				// However much a resume appends, the provider finds the prefix the last request before the exit cached.
				const lastInput = lastBeforeExit.messages.findLastIndex((message) => message.role === "user");
				assert.ok(
					cacheMarkers(firstAfterResume).some(([message]) => message === lastInput),
					`no breakpoint where the last request before the exit ended: ${JSON.stringify(cacheMarkers(firstAfterResume))}`,
				);
			});
		}
	}
});

describe("a resume after an upgrade changes only what follows the cached prefix", () => {
	for (const model of [NATIVE_MODEL, FLAT_MODEL]) {
		test(`${model}: a new prompt template, AGENTS.md and APPEND_SYSTEM.md`, async () => {
			const installation = await install(model);
			const live = await start(installation);
			await send(live, "one");
			const lastBeforeExit = await send(live, "two");
			const sessionId = live.session.sessionManager.getSessionId();
			await live.dispose();

			writeFileSync(join(installation.agentDir, "SYSTEM.md"), "You are the upgraded assistant.\n");
			writeFileSync(join(installation.agentDir, "APPEND_SYSTEM.md"), "Mind the new guidance.\n");
			writeFileSync(join(installation.cwd, "AGENTS.md"), "Prefer small, reviewed changes.\n");
			const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
			const firstAfterResume = await send(resumed, "three");

			assertExtends(lastBeforeExit, firstAfterResume);
			const appended = JSON.stringify(firstAfterResume.messages.slice(lastBeforeExit.messages.length));
			for (const change of [
				"You are the upgraded assistant.",
				"Mind the new guidance.",
				"Prefer small, reviewed changes.",
			])
				assert.ok(appended.includes(change), `${change} is not sent after the cached prefix`);
		});
	}

	test("a thinking budget changed in the settings keeps the budget the resumed session used", async () => {
		const installation = await install(BUDGET_MODEL, "install", { settings: { defaultThinkingLevel: "medium" } });
		const live = await start(installation);
		await send(live, "one");
		const lastBeforeExit = await send(live, "two");
		const sessionId = live.session.sessionManager.getSessionId();
		await live.dispose();

		const settingsPath = join(installation.agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		writeFileSync(settingsPath, JSON.stringify({ ...settings, thinkingBudgets: { medium: 4096 } }));
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const firstAfterResume = await send(resumed, "three");

		assert.deepEqual(firstAfterResume.thinking, lastBeforeExit.thinking);
		assertExtends(lastBeforeExit, firstAfterResume);
		const fresh = await send(await start(installation), "one");
		assert.deepEqual(fresh.thinking, { ...(lastBeforeExit.thinking as object), budget_tokens: 4096 });
	});

	test("tool definitions name no installation, agent directory or project path, so another install sends the same tools", async () => {
		const installation = await install(NATIVE_MODEL, "install", { builtins: true });
		const request = await send(await start(installation), "one");
		const tools = JSON.stringify(request.tools);
		assert.ok((request.tools?.length ?? 0) > 5);
		for (const path of [getPackageDir(), getDocsPath(), getExamplesPath(), installation.agentDir, installation.cwd]) {
			for (const form of [path, path.replace(/\\/g, "/")])
				assert.ok(!tools.includes(form), `a tool definition names ${form}`);
		}
	});

	test("a tool that registers before or after a built-in tool is activated ends up in the same place", async () => {
		let release: () => void = () => {};
		// Registers its tool when the test releases it, after the session started, as an MCP server that connects late.
		const lateTool: ExtensionFactory = (pi) => {
			pi.on("session_start", () => {
				void new Promise<void>((resolve) => {
					release = resolve;
				}).then(() =>
					pi.registerTool({
						name: "mcp_lookup",
						label: "mcp_lookup",
						description: "Look something up",
						parameters: Type.Object({ value: Type.String() }),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					}),
				);
			});
		};
		const installation = await install(FLAT_MODEL, "install", { factories: [lateTool] });
		const declared = async (registerFirst: boolean) => {
			const runtime = await start(installation);
			const activateLs = () => runtime.session.setActiveToolsByName([...runtime.session.getActiveToolNames(), "ls"]);
			if (!registerFirst) activateLs();
			release();
			await until(() => runtime.session.getToolDefinition("mcp_lookup") !== undefined);
			if (registerFirst) activateLs();
			else runtime.session.setActiveToolsByName([...runtime.session.getActiveToolNames()]);
			return { active: runtime.session.getActiveToolNames(), request: await send(runtime, "one") };
		};
		const registeredFirst = await declared(true);
		const activatedFirst = await declared(false);

		assert.deepEqual(registeredFirst.active, activatedFirst.active);
		assert.ok(registeredFirst.active.includes("mcp_lookup") && registeredFirst.active.includes("ls"));
		assert.equal(
			JSON.stringify(withoutCacheMarkers(registeredFirst.request).tools),
			JSON.stringify(withoutCacheMarkers(activatedFirst.request).tools),
		);
	});

	test("a tool change that redeclares other tools changes the prompt's tool list once, not again on the next request", async () => {
		const installation = await install(FLAT_MODEL);
		const runtime = await start(installation);
		await send(runtime, "one");
		const names = runtime.session.getActiveToolNames();
		assert.ok(names.includes("codemode"));
		// Without codemode the other tools' descriptions lose their script notes, so they are declared again.
		runtime.session.setActiveToolsByName(names.filter((name) => name !== "codemode"));
		const afterChange = await send(runtime, "two");
		const activeAfterChange = runtime.session.getActiveToolNames();
		const next = await send(runtime, "three");

		const toolListUpdates = (request: AnthropicRequestBody) =>
			JSON.stringify(request.messages).split('Updated system prompt section \\"tools\\"').length - 1;
		assert.equal(toolListUpdates(afterChange), 1);
		assert.equal(toolListUpdates(next), 1);
		assert.deepEqual(runtime.session.getActiveToolNames(), activeAfterChange);
		assert.equal(
			JSON.stringify(withoutCacheMarkers(next).tools),
			JSON.stringify(withoutCacheMarkers(afterChange).tools),
		);
	});

	test("tools registered in another order on resume keep the order the session declared", async () => {
		let order: readonly string[] = ["alpha_tool", "zeta_tool"];
		const installation = await install(FLAT_MODEL, "install", { tools: () => order });
		const live = await start(installation);
		await send(live, "one");
		const lastBeforeExit = await send(live, "two");
		const sessionId = live.session.sessionManager.getSessionId();
		await live.dispose();

		order = ["zeta_tool", "alpha_tool"];
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		assertExtends(lastBeforeExit, await send(resumed, "three"));
	});

	test("two sessions whose extension tools registered in opposite orders declare the same tools", async () => {
		let order: readonly string[] = ["zeta_tool", "alpha_tool"];
		const installation = await install(FLAT_MODEL, "install", { tools: () => order });
		const first = await send(await start(installation), "one");
		order = ["alpha_tool", "zeta_tool"];
		const second = await send(await start(installation), "one");

		assert.equal(JSON.stringify(withoutCacheMarkers(second).tools), JSON.stringify(withoutCacheMarkers(first).tools));
	});
});

describe("an interrupted turn resumes with the request a session that kept running sends", () => {
	for (const model of [NATIVE_MODEL, FLAT_MODEL]) {
		test(`${model}: a crash while a reply streams, against an abort at the same point`, async () => {
			const installation = await install(model);
			const control = await start(installation);
			await send(control, "one");
			server.reply("hold");
			const aborted = control.session.prompt("two").catch(() => undefined);
			const held = server.requests.length;
			await until(() => server.requests.length > held);
			await control.session.abort();
			server.dropHeld();
			await aborted;
			const controlThird = await send(control, "three");
			await control.dispose();

			const live = await start(installation);
			await send(live, "one");
			server.reply("hold");
			void live.session.prompt("two").catch(() => undefined);
			const sent = server.requests.length;
			await until(() => server.requests.length > sent);
			const lastBeforeCrash = server.requests.at(-1)!.json;
			const resumed = await openAfterCrash(installation, live);
			const firstAfterResume = await send(resumed, "three");
			server.dropHeld();

			assertExtends(lastBeforeCrash, firstAfterResume);
			assertSameAsControl(controlThird, firstAfterResume);
		});

		test(`${model}: a crash while a tool runs`, async () => {
			const installation = await install(model, "install", { tools: () => ["wait_tool"] });
			const live = await start(installation);
			await send(live, "one");
			server.reply({ toolUse: { name: "wait_tool", input: { value: "x" } } });
			const calls = waitToolCalls;
			void live.session.prompt("two").catch(() => undefined);
			await until(() => waitToolCalls > calls);
			const lastBeforeCrash = server.requests.at(-1)!.json;
			const resumed = await openAfterCrash(installation, live);
			const firstAfterResume = await send(resumed, "three");
			releaseWaitTool();

			assertExtends(lastBeforeCrash, firstAfterResume);
		});

		test(`${model}: input steered while a tool ran is replayed where it was sent`, async () => {
			const installation = await install(model, "install", { tools: () => ["wait_tool"] });
			const run = async (exit: boolean) => {
				const runtime = await start(installation);
				await send(runtime, "one");
				server.reply({ toolUse: { name: "wait_tool", input: { value: "x" } } });
				const calls = waitToolCalls;
				const turn = runtime.session.prompt("two");
				await until(() => waitToolCalls > calls);
				const steered = runtime.session.steer("steered while the tool ran");
				await until(() => runtime.session.getSteeringMessages().length > 0);
				releaseWaitTool();
				await turn;
				await steered;
				const lastBeforeExit = server.requests.at(-1)!.json;
				if (!exit) return { lastBeforeExit, next: await send(runtime, "three") };
				await runtime.dispose();
				const sessionId = runtime.session.sessionManager.getSessionId();
				const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
				return { lastBeforeExit, next: await send(resumed, "three") };
			};
			const control = await run(false);
			const resumed = await run(true);

			assertExtends(resumed.lastBeforeExit, resumed.next);
			assertSameAsControl(control.next, resumed.next);
		});
	}
});
