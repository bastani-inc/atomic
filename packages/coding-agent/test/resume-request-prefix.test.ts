import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
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

describe("a resume near the context window keeps the thinking budget (#6117)", () => {
	/**
	 * Replies report 183,000 input tokens: below the automatic compaction trigger (200,000 - 16,384), and close enough
	 * to the window that 4,000 more tokens leave too little room for the 8,192-token budget and the answer
	 * (200,000 - 4,096 - 9,216 = 186,688).
	 */
	const NEAR_WINDOW_INPUT = 183_000;
	/** About 4,000 tokens of new project instructions. */
	const MORE_INSTRUCTIONS = `Prefer small changes.\n${"Keep each change reviewed. ".repeat(520)}\n`;

	/** A session on the budget model that sent two prompts near the window, and the history's last budget. */
	async function nearWindowSession(
		settings: Record<string, unknown> = {},
		factories: ExtensionFactory[] = [],
		instructions = MORE_INSTRUCTIONS,
		inputTokens = NEAR_WINDOW_INPUT,
		tools?: () => readonly string[],
	) {
		const installation = await install(BUDGET_MODEL, "install", {
			settings: { defaultThinkingLevel: "medium", ...settings },
			factories,
			...(tools ? { tools } : {}),
		});
		server.inputTokens = inputTokens;
		const live = await start(installation);
		await send(live, "one");
		const lastBeforeExit = await send(live, "two");
		const sessionId = live.session.sessionManager.getSessionId();
		await live.dispose();
		writeFileSync(join(installation.cwd, "AGENTS.md"), instructions);
		return { installation, sessionId, lastBeforeExit };
	}

	function compactions(runtime: AgentSessionRuntime): number {
		return runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
	}

	test("instructions the resume added clear the context first instead of lowering the budget", async () => {
		const { installation, sessionId, lastBeforeExit } = await nearWindowSession();
		assert.deepEqual((lastBeforeExit.thinking as { budget_tokens?: number }).budget_tokens, 8192);

		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const firstAfterResume = await send(resumed, "three");

		assert.equal((firstAfterResume.thinking as { budget_tokens?: number }).budget_tokens, 8192);
		assert.equal(compactions(resumed), 1);
		const sent = JSON.stringify(firstAfterResume.messages);
		assert.ok(sent.includes("Keep each change reviewed."), "the new instructions are not sent");
		assert.ok(!sent.includes('"one"') && !sent.includes("answer to one"), "the cleared history is still sent");

		// Only the first request after the resume is checked.
		await send(resumed, "four");
		assert.equal(compactions(resumed), 1);
	});

	test("what an extension added on resume is still sent after the clear", async () => {
		let resuming = false;
		const note: ExtensionFactory = (pi) => {
			pi.on("session_start", () => {
				if (resuming)
					pi.sendMessage(
						{ customType: "resume-note", content: "The build cache was restored.", display: true },
						{ triggerTurn: false },
					);
			});
		};
		const { installation, sessionId } = await nearWindowSession({}, [note]);
		resuming = true;
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		await until(() => resumed.session.messages.some((message) => message.role === "custom"));
		const firstAfterResume = await send(resumed, "three");

		assert.equal(compactions(resumed), 1);
		assert.ok(JSON.stringify(firstAfterResume.messages).includes("The build cache was restored."));
		// The clear covers the restored history only: the note stays in the context as the entry it was.
		const notes = resumed.session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "resume-note");
		assert.equal(notes.length, 1);
	});

	test("instructions an extension leaves out of every request do not clear the context", async () => {
		const withoutProjectContext: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.contextFiles = [];
			});
		};
		const { installation, sessionId, lastBeforeExit } = await nearWindowSession({}, [withoutProjectContext]);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const firstAfterResume = await send(resumed, "three");

		assert.equal(compactions(resumed), 0);
		assert.deepEqual(firstAfterResume.thinking, lastBeforeExit.thinking);
		const sent = JSON.stringify(firstAfterResume.messages);
		assert.ok(sent.includes("answer to one"), "the history is not sent");
		assert.ok(!sent.includes("Keep each change reviewed."), "the left-out instructions are sent");
	});

	for (const [name, handler] of [
		[
			"a forced system prompt, which leaves prompt updates out",
			(pi) => pi.on("before_agent_start", () => ({ systemPrompt: "You are a careful assistant." })),
		],
		[
			"a forced system prompt built from the session's",
			(pi) => pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\nAlways be brief.` })),
		],
	] as Array<[string, ExtensionFactory]>) {
		test(`with ${name}, the context is not cleared`, async () => {
			const { installation, sessionId, lastBeforeExit } = await nearWindowSession({}, [handler]);
			const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
			const firstAfterResume = await send(resumed, "three");

			assert.equal(compactions(resumed), 0);
			assert.ok(JSON.stringify(firstAfterResume.messages).includes("answer to one"), "the history is not sent");
			assert.equal(
				(firstAfterResume.thinking as { budget_tokens?: number } | undefined)?.budget_tokens,
				(lastBeforeExit.thinking as { budget_tokens?: number }).budget_tokens,
			);
		});
	}

	for (const event of ["context", "context_with_system"] as const)
		test(`with a ${event} handler that leaves a long resume note out of every request, the context is not cleared`, async () => {
			let resuming = false;
			const note: ExtensionFactory = (pi) => {
				pi.on("session_start", () => {
					if (resuming)
						pi.sendMessage(
							{ customType: "resume-note", content: `Restored. ${"Cache notes. ".repeat(1500)}`, display: true },
							{ triggerTurn: false },
						);
				});
				pi.on(event, (context) => ({
					messages: context.messages.filter(
						(message) => !(message.role === "custom" && message.customType === "resume-note"),
					),
				}));
			};
			const { installation, sessionId, lastBeforeExit } = await nearWindowSession({}, [note]);
			writeFileSync(join(installation.cwd, "AGENTS.md"), "Prefer small changes.\n");
			resuming = true;
			const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
			await until(() => resumed.session.messages.some((message) => message.role === "custom"));
			const firstAfterResume = await send(resumed, "three");

			assert.equal(compactions(resumed), 0);
			assert.ok(JSON.stringify(firstAfterResume.messages).includes("answer to one"), "the history is not sent");
			assert.deepEqual(firstAfterResume.thinking, lastBeforeExit.thinking);
		});

	test("with image reading disabled, images in the prompt count as the text that is sent for them", async () => {
		// About 2,000 tokens of new instructions fit with the budget; two images counted as images would not.
		const { installation, sessionId, lastBeforeExit } = await nearWindowSession(
			{ images: { blockImages: true } },
			[],
			`Prefer small changes.\n${"Keep each change reviewed. ".repeat(260)}\n`,
		);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const image = { type: "image" as const, data: pixel, mimeType: "image/png" };
		await resumed.session.prompt("three", { images: [image, image] });
		const firstAfterResume = server.requests.at(-1)!.json;

		assert.equal(compactions(resumed), 0);
		assert.ok(JSON.stringify(firstAfterResume.messages).includes("answer to one"), "the history is not sent");
		assert.deepEqual(firstAfterResume.thinking, lastBeforeExit.thinking);
	});

	const budgetOf = (request: AnthropicRequestBody) =>
		(request.thinking as { budget_tokens?: number } | undefined)?.budget_tokens ?? 0;
	/** The first request sent after `before` requests, once the run that sent it has ended. */
	async function firstRequestAfter(runtime: AgentSessionRuntime, before: number): Promise<AnthropicRequestBody> {
		await until(
			() =>
				server.requests.length > before &&
				!runtime.session.isStreaming &&
				runtime.session.messages.at(-1)?.role === "assistant",
		);
		return server.requests[before]!.json;
	}

	test("a run an extension starts first after the resume clears first too", async () => {
		let kick = (): void => {};
		const starter: ExtensionFactory = (pi) => {
			kick = () => {
				void pi.sendMessage({ customType: "kick", content: "Carry on.", display: true }, { triggerTurn: true });
			};
		};
		const { installation, sessionId } = await nearWindowSession({}, [starter]);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const before = server.requests.length;
		kick();
		const firstAfterResume = await firstRequestAfter(resumed, before);

		assert.equal(budgetOf(firstAfterResume), 8192);
		assert.equal(compactions(resumed), 1);
		const sent = JSON.stringify(firstAfterResume.messages);
		assert.ok(sent.includes("Keep each change reviewed."), "the new instructions are not sent");
		assert.ok(sent.includes("Carry on."), "the extension's message is not sent");
		assert.ok(!sent.includes("answer to one"), "the cleared history is still sent");
	});

	/**
	 * With the high level's 16,384-token budget, replies that report 172,000 input tokens leave room for it, and about
	 * 8,000 tokens more do not, while the context stays below the automatic compaction trigger.
	 */
	const HIGH_NEAR_WINDOW_INPUT = 172_000;
	const RECOVERY_NOTICE = `Restored. ${"Keep each change reviewed. ".repeat(1185)}`;

	for (const queue of ["steer", "followUp"] as const)
		test(`a ${queue} message that continues the resumed session clears first when the recovery notice would lower the budget`, async () => {
			const recovering: ExtensionFactory = (pi) => {
				pi.on("session_recovery_restore", () => ({ notices: [RECOVERY_NOTICE] }));
			};
			const { installation, sessionId, lastBeforeExit } = await nearWindowSession(
				{ defaultThinkingLevel: "high" },
				[recovering],
				"Prefer small changes.\n",
				HIGH_NEAR_WINDOW_INPUT,
			);
			assert.equal(budgetOf(lastBeforeExit), 16_384);
			const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
			await resumed.session.startPendingRecovery("resume");
			const before = server.requests.length;
			await resumed.session[queue]("three");
			const firstAfterResume = await firstRequestAfter(resumed, before);

			assert.equal(budgetOf(firstAfterResume), 16_384);
			assert.equal(compactions(resumed), 1);
			const sent = JSON.stringify(firstAfterResume.messages);
			assert.ok(sent.includes("Session recovery after restart"), "the recovery notice is not sent");
			assert.ok(!sent.includes("answer to one"), "the cleared history is still sent");
			// A continued turn takes steering input first; follow-up input waits for the turn after it, as it would have.
			assert.equal(sent.includes("three"), queue === "steer");
		});

	test("what an extension adds after the session opened counts as the conversation's, so it does not clear", async () => {
		let addTask = (): void => {};
		const tasks: ExtensionFactory = (pi) => {
			addTask = () => {
				void pi.sendMessage(
					{ customType: "task", content: `Task: ${"Keep each change reviewed. ".repeat(520)}`, display: true },
					{ triggerTurn: false },
				);
			};
		};
		const { installation, sessionId } = await nearWindowSession({}, [tasks], "Prefer small changes.\n");
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		addTask();
		await until(() => resumed.session.messages.some((message) => message.role === "custom"));
		const firstAfterResume = await send(resumed, "three");

		// A session that kept running would have sent the task with the history and a lower budget too.
		assert.equal(compactions(resumed), 0);
		assert.ok(JSON.stringify(firstAfterResume.messages).includes("answer to one"), "the history is not sent");
		assert.ok(budgetOf(firstAfterResume) < 8192, `budget ${budgetOf(firstAfterResume)}`);
	});

	test("a session summary requested before the first prompt leaves the clear to the prompt", async () => {
		const { installation, sessionId } = await nearWindowSession();
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const before = server.requests.length;
		// RPC and interactive modes summarize a resumed session for the session picker as soon as it opens.
		await resumed.session.bindExtensions({ mode: "rpc" });
		await until(() => resumed.session.sessionManager.getEntries().some((entry) => entry.type === "session_summary"));
		assert.equal(server.requests.length, before + 1, "the summary was not requested");

		// The turn's end requests the next summary, so the prompt's own request is the first one it sends.
		await resumed.session.prompt("three");
		const firstAfterResume = server.requests[before + 1]!.json;
		assert.equal(budgetOf(firstAfterResume), 8192);
		assert.equal(compactions(resumed), 1);
	});

	test("a continuation that sends nothing leaves the clear to the first request", async () => {
		const { installation, sessionId } = await nearWindowSession();
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const before = server.requests.length;
		// Nothing is queued and the restored history ends with a reply, so the continuation stops before a request.
		await assert.rejects(resumed.session._continueAgentAfterCompactionCheck(), /Cannot continue from message role/);
		assert.equal(server.requests.length, before);

		const firstAfterResume = await send(resumed, "three");
		assert.equal(budgetOf(firstAfterResume), 8192);
		assert.equal(compactions(resumed), 1);
	});

	test("a request whose provider setup fails leaves the clear to the request that follows", async () => {
		const recovering: ExtensionFactory = (pi) => {
			pi.on("session_recovery_restore", () => ({ notices: [RECOVERY_NOTICE] }));
		};
		const { installation, sessionId } = await nearWindowSession(
			{ defaultThinkingLevel: "high" },
			[recovering],
			"Prefer small changes.\n",
			HIGH_NEAR_WINDOW_INPUT,
		);
		// The model's requests carry a header taken from an environment variable, which is unset at first.
		writeFileSync(
			join(installation.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: server.baseUrl,
						modelOverrides: { [BUDGET_MODEL]: { headers: { "x-team": "$ATOMIC_TEST_TEAM_HEADER" } } },
					},
				},
			}),
		);
		vi.stubEnv("ATOMIC_TEST_TEAM_HEADER", undefined);
		cleanups.push(() => vi.unstubAllEnvs());
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const before = server.requests.length;
		// The first prompt's request fails before anything is sent.
		await resumed.session.prompt("three").catch(() => {});
		assert.equal(server.requests.length, before);

		// The next prompt is the first request the provider gets, so it is checked with the notice the resume added
		// since, as a prompt that follows a sent request is not.
		vi.stubEnv("ATOMIC_TEST_TEAM_HEADER", "core");
		await resumed.session.startPendingRecovery("resume");
		const firstAfterResume = await send(resumed, "four");
		assert.equal(budgetOf(firstAfterResume), 16_384);
		assert.equal(compactions(resumed), 1);
	});

	test("an interrupt sent first after the resume leaves the clear to the prompt that sends the new instructions", async () => {
		let interrupt = (): Promise<void> => Promise.resolve();
		const interrupting: ExtensionFactory = (pi) => {
			interrupt = () =>
				pi.sendMessage(
					{ customType: "ping", content: "Interrupting.", display: true },
					{ deliverAs: "interrupt", triggerTurn: true },
				);
		};
		const { installation, sessionId } = await nearWindowSession({}, [interrupting]);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const before = server.requests.length;
		await interrupt();
		const interrupted = await firstRequestAfter(resumed, before);
		// The interrupt's request goes out without the instructions the resume added, at the budget it had.
		assert.equal(budgetOf(interrupted), 8192);
		assert.ok(!JSON.stringify(interrupted).includes("Keep each change reviewed."));
		assert.equal(compactions(resumed), 0);

		const prompted = await send(resumed, "four");
		assert.equal(budgetOf(prompted), 8192);
		assert.equal(compactions(resumed), 1);
		// The clear covers the restored history only: the interrupt and its answer are still sent.
		assert.ok(JSON.stringify(prompted.messages).includes("Interrupting."), "the interrupt is not sent");
		assert.ok(!JSON.stringify(prompted.messages).includes("answer to one"), "the cleared history is still sent");
		assert.ok(
			JSON.stringify(prompted.messages).includes("Keep each change reviewed."),
			"the new instructions are not sent",
		);
	});

	/** The snippet of `helper_tool`, a tool `enable_helper` turns on. */
	const HELPER_SNIPPET = "Ask helper_tool for help.";

	/** `helper_tool`, off at first, and `enable_helper`, which turns it on when called. */
	const helperTools: ExtensionFactory = (pi) => {
		pi.on("session_start", () => {
			pi.registerTool({
				name: "helper_tool",
				label: "helper_tool",
				description: "The helper tool",
				promptSnippet: HELPER_SNIPPET,
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "helped" }], details: {} }),
			});
			pi.registerTool({
				name: "enable_helper",
				label: "enable_helper",
				description: "Turns the helper tool on",
				parameters: Type.Object({}),
				execute: async () => {
					pi.setActiveTools([...pi.getActiveTools(), "helper_tool"]);
					return { content: [{ type: "text", text: "enabled" }], details: {} };
				},
			});
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "helper_tool"));
		});
	};

	/** An extension that sends an interrupt when `interrupt()` is called. */
	function interrupter() {
		const hooks = { interrupt: (): Promise<void> => Promise.resolve() };
		const factory: ExtensionFactory = (pi) => {
			hooks.interrupt = () =>
				pi.sendMessage(
					{ customType: "ping", content: "Interrupting.", display: true },
					{ deliverAs: "interrupt", triggerTurn: true },
				);
		};
		return { hooks, factory };
	}

	/** The requests a run sends after `before`, once it has ended and sent `count` of them. */
	async function runRequests(runtime: AgentSessionRuntime, before: number, count: number) {
		await until(
			() =>
				server.requests.length >= before + count &&
				!runtime.session.isStreaming &&
				runtime.session.messages.at(-1)?.role === "assistant",
		);
		return server.requests.slice(before).map((request) => JSON.stringify(request.json));
	}

	test("the turn after an interrupt's tool call holds back the new instructions, and the next prompt sends them after the clear", async () => {
		const { hooks, factory } = interrupter();
		// A section of the prompt that only a prompt's start sets, as the MCP servers' section is.
		const sectioning: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", (event) => {
				event.systemPromptOptions.sections.probe = "Probe section.";
			});
		};
		const { installation, sessionId } = await nearWindowSession(
			{},
			[factory, sectioning],
			MORE_INSTRUCTIONS,
			NEAR_WINDOW_INPUT,
			() => ["probe_tool"],
		);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const before = server.requests.length;
		server.reply({ toolUse: { name: "probe_tool", input: { value: "x" } } }, { text: "done" });
		await hooks.interrupt();
		const run = await runRequests(resumed, before, 2);
		assert.equal(run.length, 2);
		// Both requests of the interrupt's run keep the prompt and budget the interrupt was sent with.
		for (const request of run) {
			assert.equal(budgetOf(JSON.parse(request)), 8192);
			assert.ok(!request.includes("Keep each change reviewed."), "the new instructions are sent");
			assert.ok(request.includes("Probe section."), "a section a prompt set is dropped");
		}
		assert.ok(run[1]!.includes("probe_tool done"), "the tool result is not sent");
		assert.equal(compactions(resumed), 0);

		const prompted = await send(resumed, "four");
		assert.equal(budgetOf(prompted), 8192);
		assert.equal(compactions(resumed), 1);
		const sent = JSON.stringify(prompted.messages);
		assert.ok(sent.includes("Keep each change reviewed."), "the new instructions are not sent");
		assert.equal(sent.split("probe_tool done").length - 1, 1, "the tool result is not sent once");
	});

	test("while the new instructions are held back, a tool an interrupt's run turned on is still described", async () => {
		const { hooks, factory } = interrupter();
		const { installation, sessionId } = await nearWindowSession({}, [factory, helperTools]);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const before = server.requests.length;
		server.reply({ toolUse: { name: "enable_helper", input: {} } }, { text: "done" });
		await hooks.interrupt();
		const run = await runRequests(resumed, before, 2);
		assert.ok(!run[1]!.includes("Keep each change reviewed."), "the new instructions are sent");
		assert.ok(run[1]!.includes(HELPER_SNIPPET), "the tool turned on is not described");
	});

	for (const [name, first] of [
		["an interrupt", (_runtime: AgentSessionRuntime, interrupt: () => Promise<void>) => interrupt()],
		["a message steered while idle", (runtime: AgentSessionRuntime) => runtime.session.steer("go on")],
	] as const)
		test(`with no prompt update pending, ${name} sent first after the resume describes a tool its run turned on`, async () => {
			const { hooks, factory } = interrupter();
			const { installation, sessionId } = await nearWindowSession(
				{},
				[factory, helperTools],
				"Prefer small changes.\n",
			);
			const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
			const before = server.requests.length;
			server.reply({ toolUse: { name: "enable_helper", input: {} } }, { text: "done" });
			await first(resumed, hooks.interrupt);
			const run = await runRequests(resumed, before, 2);
			assert.ok(!run[0]!.includes(HELPER_SNIPPET));
			assert.ok(run[1]!.includes(HELPER_SNIPPET), "the tool turned on is not described");
		});

	test("with no prompt update pending, an interrupt sent first after the resume ends the check, as a prompt would", async () => {
		const { hooks, factory } = interrupter();
		const recovering: ExtensionFactory = (pi) => {
			pi.on("session_recovery_restore", () => ({ notices: [RECOVERY_NOTICE] }));
		};
		const { installation, sessionId } = await nearWindowSession(
			{ defaultThinkingLevel: "high" },
			[factory, recovering],
			"Prefer small changes.\n",
			HIGH_NEAR_WINDOW_INPUT,
		);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const before = server.requests.length;
		await hooks.interrupt();
		await runRequests(resumed, before, 1);
		await resumed.session.startPendingRecovery("resume");

		const second = await send(resumed, "four");
		assert.equal(compactions(resumed), 0);
		assert.ok(budgetOf(second) < 16_384, `budget ${budgetOf(second)}`);
	});

	test("with no prompt update pending, a second interrupt's run describes a tool it turned on", async () => {
		const { hooks, factory } = interrupter();
		const { installation, sessionId } = await nearWindowSession(
			{},
			[factory, helperTools],
			"Prefer small changes.\n",
		);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const before = server.requests.length;
		await hooks.interrupt();
		await runRequests(resumed, before, 1);
		server.reply({ toolUse: { name: "enable_helper", input: {} } }, { text: "done" });
		await hooks.interrupt();
		const run = await runRequests(resumed, before, 3);
		assert.ok(run[2]!.includes(HELPER_SNIPPET), "the tool turned on is not described");
	});

	test("once the first request after the resume went out, a tool turned on during a run is described in the prompt of the run's next request", async () => {
		const { installation, sessionId } = await nearWindowSession({}, [helperTools]);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		await send(resumed, "three");
		const before = server.requests.length;
		server.reply({ toolUse: { name: "enable_helper", input: {} } }, { text: "done" });
		await send(resumed, "four");
		const run = server.requests.slice(before).map((request) => JSON.stringify(request.json));
		assert.equal(run.length, 2);
		assert.ok(!run[0]!.includes(HELPER_SNIPPET));
		assert.ok(run[1]!.includes(HELPER_SNIPPET), "the tool turned on is not described");
	});

	test("a recovery notice added after the first prompt does not clear the context for the next one", async () => {
		const recovering: ExtensionFactory = (pi) => {
			pi.on("session_recovery_restore", () => ({ notices: [RECOVERY_NOTICE] }));
		};
		const { installation, sessionId } = await nearWindowSession(
			{ defaultThinkingLevel: "high" },
			[recovering],
			"Prefer small changes.\n",
			HIGH_NEAR_WINDOW_INPUT,
		);
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const first = await send(resumed, "three");
		assert.equal(budgetOf(first), 16_384);
		await resumed.session.startPendingRecovery("resume");

		// Only the first request after the resume is checked; the notice now lowers the next budget, as before.
		const second = await send(resumed, "four");
		assert.equal(compactions(resumed), 0);
		assert.ok(budgetOf(second) < 16_384, `budget ${budgetOf(second)}`);
		assert.ok(JSON.stringify(second.messages).includes("answer to one"), "the history is not sent");
	});

	test("with automatic compaction off, the request lowers the budget to fit as before", async () => {
		const { installation, sessionId } = await nearWindowSession({ compaction: { enabled: false } });
		const resumed = await start(installation, await openWithFlags(installation, ["--session", sessionId]));
		const firstAfterResume = await send(resumed, "three");

		const budget = (firstAfterResume.thinking as { budget_tokens?: number } | undefined)?.budget_tokens ?? 0;
		assert.ok(budget < 8192, `budget ${budget}`);
		assert.equal(compactions(resumed), 0);
	});
});
