import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/atomic-ai/compat";
import { afterEach, describe, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import {
	type AgentSession,
	AuthStorage,
	convertToLlm,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SESSION_HISTORY_TOOL_NAME,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";

const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;
const CONTEXT_WINDOW = 200_000;
const RESERVE_TOKENS = 20_000;
/** About 185k tokens: with the system prompt the answer's reported usage is over the trigger and inside the window. */
const LARGE_PROMPT = `long task\n${"word ".repeat(148_000)}`;
const COMPACTOR = "morph/morph-compactor";

type Factory = (pi: ExtensionAPI) => void;

interface Opened {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly faux: ReturnType<typeof registerFauxProvider>;
	readonly requests: string[][];
	/** Dispose the session, open its saved file again and start a new session on it. */
	reopen(options?: { tools?: string[]; defaultTools?: string[] }): Promise<AgentSession>;
}

describe("compaction through the public SDK entry points", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function open(
		options: {
			compactionModel?: string;
			extension?: Factory;
			replies?: string[];
			defaultTools?: string[];
			persisted?: boolean;
		} = {},
	): Promise<Opened> {
		const dir = mkdtempSync(join(tmpdir(), "atomic-compaction-sdk-"));
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "sdk-window", contextWindow: CONTEXT_WINDOW }] });
		const model = faux.getModel();
		const requests: string[][] = [];
		faux.setResponses(
			(options.replies ?? ["answer"]).map((reply) => (context: { messages: Array<{ role: string }> }) => {
				requests.push(context.messages.map((message) => message.role));
				return fauxAssistantMessage(reply);
			}),
		);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		await authStorage.modify("morph", async () => ({ type: "api_key", key: "sk-morph-sdk-test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(dir, "models.json"),
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				input: registered.input,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
				cost: registered.cost,
			})),
		});
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
			...(options.compactionModel ? { compactionModel: options.compactionModel } : {}),
			...(options.defaultTools ? { defaultTools: options.defaultTools } : {}),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir,
			settingsManager,
			...(options.extension ? { extensionFactories: [options.extension] } : {}),
		});
		await resourceLoader.reload();
		const sessionManager = options.persisted
			? await SessionManager.create(dir, join(dir, "sessions"))
			: SessionManager.inMemory(dir);
		const start = async (
			manager: SessionManager,
			overrides: { tools?: string[]; defaultTools?: string[] } = {},
		): Promise<AgentSession> => {
			const effectiveSettings =
				overrides.defaultTools === undefined
					? settingsManager
					: SettingsManager.inMemory({
							retry: { enabled: false },
							compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
							...(options.compactionModel ? { compactionModel: options.compactionModel } : {}),
							defaultTools: overrides.defaultTools,
						});
			const { session } = await createAgentSession({
				cwd: dir,
				agentDir,
				model,
				modelRuntime,
				settingsManager: effectiveSettings,
				sessionManager: manager,
				resourceLoader,
				builtins: NO_BUILTINS,
				...(overrides.tools ? { tools: overrides.tools } : {}),
			});
			cleanups.push(() => session.dispose());
			return session;
		};
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		cleanups.push(() => faux.unregister());
		const session = await start(sessionManager);
		const reopen = async (
			reopenOptions: { tools?: string[]; defaultTools?: string[] } = {},
		): Promise<AgentSession> => {
			const file = sessionManager.getSessionFile();
			assert.ok(file, "the session is saved to a file");
			session.dispose();
			return start(await SessionManager.open(file), reopenOptions);
		};
		return { session, sessionManager, faux, requests, reopen };
	}

	function compactionEntries(opened: Opened) {
		return opened.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
	}

	it("a manual compact() clears the context with no model call", async () => {
		const opened = await open();
		await opened.session.prompt("do the task");

		const result = await opened.session.compact({ query: "keep the parser notes" });

		assert.equal(result.form, "cleared");
		assert.equal(opened.faux.state.callCount, 1);
		assert.deepEqual(
			convertToLlm(opened.session.messages).map((message) => message.role),
			["system", "user"],
		);
		assert.ok(result.compactedText.includes("keep the parser notes"));
		assert.equal(opened.session.getLastAssistantText(), "answer");
	});

	it("an answer over the threshold stays the last answer, and the next prompt goes out after a clear", async () => {
		const opened = await open({ replies: ["CURRENT-FINAL-ANSWER", "next answer"] });
		await opened.session.prompt(LARGE_PROMPT);

		assert.equal(opened.session.getLastAssistantText(), "CURRENT-FINAL-ANSWER");
		assert.equal(compactionEntries(opened).length, 0);

		await opened.session.prompt("next");

		assert.equal(compactionEntries(opened).length, 1);
		assert.deepEqual(opened.requests.at(-1), ["system", "user", "user"]);
		assert.equal(opened.faux.state.callCount, 2, "the clear made no model call");
	});

	it("a configured compactor's output replaces the context", async () => {
		const realFetch = globalThis.fetch;
		cleanups.push(() => {
			globalThis.fetch = realFetch;
		});
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ output: "compacted notes from the endpoint" }), {
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		const opened = await open({ compactionModel: COMPACTOR });
		await opened.session.prompt("do the task");

		const result = await opened.session.compact();

		assert.equal(result.form, "compacted");
		assert.ok(result.compactedText.includes("compacted notes from the endpoint"));
		assert.equal(opened.faux.state.callCount, 1);
	});

	it("a session_before_compact handler can cancel a compaction", async () => {
		const opened = await open({
			extension: (pi) => {
				pi.on("session_before_compact", async () => ({ cancel: true }));
			},
		});
		await opened.session.prompt("do the task");

		await assert.rejects(opened.session.compact(), /cancel/i);
		assert.equal(compactionEntries(opened).length, 0);
		assert.equal(opened.session.getLastAssistantText(), "answer");
	});

	it("a session_before_compact handler can supply the replacement text", async () => {
		const opened = await open({
			extension: (pi) => {
				pi.on("session_before_compact", async () => ({ compactedText: "notes from the extension" }));
			},
		});
		await opened.session.prompt("do the task");

		const result = await opened.session.compact();

		assert.equal(result.form, "compacted");
		assert.ok(result.compactedText.includes("notes from the extension"));
		assert.equal(compactionEntries(opened).length, 1);
	});

	it("a restricted agent keeps its history tool when its session is resumed after a clear", async () => {
		const opened = await open({ defaultTools: [], persisted: true });
		assert.ok(!opened.session.getActiveToolNames().includes("read"));
		await opened.session.prompt("do the task");
		await opened.session.compact();
		assert.ok(opened.session.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));

		const resumed = await opened.reopen();

		assert.ok(resumed.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));
		assert.ok(resumed.getToolDefinition(SESSION_HISTORY_TOOL_NAME));
	});

	it("an agent with read and search resumes without the history tool", async () => {
		const opened = await open({ persisted: true });
		await opened.session.prompt("do the task");
		await opened.session.compact();
		assert.ok(!opened.session.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));

		const resumed = await opened.reopen();

		assert.ok(resumed.getActiveToolNames().includes("read"));
		assert.ok(!resumed.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));
	});

	it("a session cleared with read and search gets the history tool when resumed with tools: []", async () => {
		const other = await open({ persisted: true });
		await other.session.prompt("secret in another session");
		const opened = await open({ persisted: true });
		await opened.session.prompt("do the task in this session");
		await opened.session.compact();
		assert.ok(!opened.session.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));

		const resumed = await opened.reopen({ tools: [] });

		assert.ok(resumed.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));
		const definition = resumed.getToolDefinition(SESSION_HISTORY_TOOL_NAME);
		assert.ok(definition);
		assert.deepEqual(Object.keys((definition.parameters as { properties: object }).properties).sort(), [
			"lines",
			"pattern",
		]);
		const ctx = {} as Parameters<typeof definition.execute>[4];
		const own = await definition.execute("c1", { pattern: "do the task in this session" }, undefined, undefined, ctx);
		assert.ok(JSON.stringify(own.content).includes(`history://sessions/${resumed.sessionId}:`));
		const foreign = await definition.execute(
			"c2",
			{ pattern: `secret in another session|${other.session.sessionId}|\\?project=all` },
			undefined,
			undefined,
			ctx,
		);
		assert.ok(JSON.stringify(foreign.content).includes("No matches."));
	});

	it("a session cleared with read and search gets the history tool when resumed with only read", async () => {
		const opened = await open({ persisted: true });
		await opened.session.prompt("do the task");
		await opened.session.compact();

		const resumed = await opened.reopen({ tools: ["read"] });

		assert.ok(resumed.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));
		assert.ok(resumed.getToolDefinition(SESSION_HISTORY_TOOL_NAME));
	});

	it("a session cleared while restricted resumes without the history tool when read and search are active", async () => {
		const opened = await open({ defaultTools: [], persisted: true });
		await opened.session.prompt("do the task");
		await opened.session.compact();
		assert.ok(opened.session.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));

		const resumed = await opened.reopen({ tools: ["read", "search"] });

		assert.ok(resumed.getActiveToolNames().includes("read"));
		assert.ok(resumed.getActiveToolNames().includes("search"));
		assert.ok(!resumed.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));
		assert.equal(resumed.getToolDefinition(SESSION_HISTORY_TOOL_NAME), undefined);
	});

	it("narrowing active tools mid-session after a clear grants the history tool, and restoring read and search removes it", async () => {
		const opened = await open({ replies: ["answer", "second answer"] });
		await opened.session.prompt("do the task");
		await opened.session.compact();
		assert.ok(!opened.session.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));

		opened.session.setActiveToolsByName(["read"]);
		assert.ok(opened.session.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));
		assert.ok(opened.session.getToolDefinition(SESSION_HISTORY_TOOL_NAME));

		opened.session.setActiveToolsByName(["read", "search"]);
		assert.ok(!opened.session.getActiveToolNames().includes(SESSION_HISTORY_TOOL_NAME));
		assert.equal(opened.session.getToolDefinition(SESSION_HISTORY_TOOL_NAME), undefined);

		opened.session.setActiveToolsByName(["read"]);
		await opened.session.prompt("another turn");
		await opened.session.compact();
		assert.deepEqual(opened.session.getActiveToolNames().sort(), ["read", SESSION_HISTORY_TOOL_NAME].sort());
	});
});
