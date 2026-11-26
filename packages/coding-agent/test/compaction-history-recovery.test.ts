import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@bastani/atomic-agent-core";
import type { AssistantMessage, Message } from "@bastani/atomic-ai/compat";
import { afterEach, describe, it } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { VerbatimCompactionResult } from "../src/core/compaction/index.ts";
import { convertToLlm } from "../src/core/messages.js";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import type { InternalResourceContext } from "../src/core/tools/resource-selectors.js";
import { createSearchToolDefinition } from "../src/core/tools/search.js";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

useTemporaryAgentDir();

const REQUIREMENT = "needle-4568 the unique requirement the clear removes from context";
const KEPT_SPAN = "<keepContext>\nNever push to main.\n</keepContext>";

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function conversation(): Message[] {
	const filler = Array.from({ length: 24 }, (_, index) => `filler line ${index}`).join("\n");
	return [
		{ role: "user", content: `task 0\n${REQUIREMENT}\n${KEPT_SPAN}\n${filler}`, timestamp: 1 },
		assistant("answer 0", 2),
		{ role: "user", content: "task 1", timestamp: 3 },
		assistant("answer 1", 4),
	];
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

/** No compaction may call a model: any request fails the test. */
const refusingStream: StreamFn = () => {
	throw new Error("compaction called a model");
};

interface StoreBackend {
	readonly name: string;
	open(dir: string): Promise<{ manager: SessionManager; close(): Promise<void> }>;
}

async function managerIn(store: SessionStore, cwd: string): Promise<SessionManager> {
	return SessionManager.create(store, cwd);
}

const STORES: readonly StoreBackend[] = [
	{ name: "memory", open: async (dir) => ({ manager: SessionManager.inMemory(dir), close: async () => {} }) },
	{
		name: "JSONL",
		open: async (dir) => {
			const store = await JsonlSessionStore.open(join(dir, "jsonl"));
			return { manager: await managerIn(store, dir), close: () => store.close() };
		},
	},
	{
		name: "SQLite",
		open: async (dir) => {
			const database = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
			const store = await SqlSessionStore.open(database);
			return {
				manager: await managerIn(store, dir),
				close: async () => {
					await store.close();
					await database.close();
				},
			};
		},
	},
];

describe("recovery from session history after a clear", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	async function clearedSession(backend: StoreBackend): Promise<{
		session: AgentSession;
		cwd: string;
		result: VerbatimCompactionResult;
		entriesBefore: number;
		earlierEntries: SessionEntry[];
	}> {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-history-recovery-"));
		const opened = await backend.open(cwd);
		const manager = opened.manager;
		const agent = new Agent({
			getApiKey: () => undefined,
			initialState: { model: getFixtureModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: "test", tools: [] },
			streamFn: refusingStream,
		});
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory(),
			cwd,
			modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(async () => {
			session.dispose();
			await opened.close();
			rmSync(cwd, { recursive: true, force: true });
		});
		for (const message of conversation()) await manager.appendMessage(message);
		session.agent.state.messages = manager.buildSessionContext().messages;
		const entriesBefore = manager.getLastSeq();
		const earlierEntries = structuredClone(manager.getEntries());
		const result = await session.compact();
		return { session, cwd, result, entriesBefore, earlierEntries };
	}

	function historyRouter(session: AgentSession, cwd: string) {
		return createHistoryRouter({
			cwd,
			currentSessionId: session.sessionId,
			sessionStore: () => session.sessionManager.getSessionStore(),
		});
	}

	function tools(session: AgentSession, cwd: string) {
		const ctx = { internalResourceRouter: historyRouter(session, cwd), cwd } as InternalResourceContext;
		return {
			search: async (pattern: string, paths: string) =>
				toolText(
					await createSearchToolDefinition(cwd).execute(
						"search",
						{ pattern, paths },
						undefined,
						undefined,
						ctx as never,
					),
				),
			read: async (path: string) =>
				toolText(await createReadToolDefinition(cwd).execute("read", { path }, undefined, undefined, ctx as never)),
		};
	}

	function boundaryText(session: AgentSession): string {
		const context = convertToLlm(session.sessionManager.buildSessionContext().messages);
		const nonSystem = context.filter((message) => message.role !== "system");
		assert.equal(nonSystem.length, 1, "the context holds one message besides the system prompt");
		const [first] = nonSystem;
		assert.equal(first?.role, "user");
		assert.ok(typeof first?.content !== "string");
		return first.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	}

	for (const backend of STORES) {
		it(`advertises readable history entry positions for a session in ${backend.name} storage (#5250)`, async () => {
			const { session, cwd, result, entriesBefore, earlierEntries } = await clearedSession(backend);
			const url = `history://sessions/${session.sessionId}`;
			const text = boundaryText(session);
			assert.equal(text, result.compactedText);
			assert.ok(text.startsWith("Context cleared."), text);
			assert.ok(!text.includes(REQUIREMENT), "the requirement left the context window");

			const history = result.history;
			assert.ok(history, "the result says where the boundary sits");
			assert.equal(history.sessionId, session.sessionId);
			assert.ok(text.includes(`entries 1-${entriesBefore} hold the earlier conversation`), text);
			assert.equal(history.entriesBefore, entriesBefore);
			assert.equal(history.boundaryEntry, entriesBefore + 1);
			assert.equal(history.totalEntries, entriesBefore + 1);
			assert.equal(history.rangeUnit, "entries");
			const router = historyRouter(session, cwd);
			const before = await router.readSelected?.(url, { ranges: [{ start: 1, end: entriesBefore }] });
			assert.ok(before?.includes(REQUIREMENT), before);
			assert.ok(before?.includes(KEPT_SPAN), before);
			const boundary = await router.readSelected?.(url, {
				ranges: [{ start: history.boundaryEntry, end: history.boundaryEntry }],
			});
			assert.ok(boundary?.includes(result.compactedText), boundary);
			assert.equal(session.sessionManager.getLastSeq(), history.totalEntries);
			assert.deepEqual(
				(await session.sessionManager.getSessionStore().load(session.sessionId)).entries.slice(0, entriesBefore),
				earlierEntries,
				"every earlier entry is unchanged",
			);
		});

		it(`finds pre-boundary entries through the exact URL for a session in ${backend.name} storage (#5250)`, async () => {
			const { session, cwd } = await clearedSession(backend);
			const url = `history://sessions/${session.sessionId}`;
			const { search, read } = tools(session, cwd);
			const found = await search("needle-4568", url);
			const resultLine = found.split("\n").find((row) => row.startsWith(`${url}:`));
			const match = /^:(\d+): /.exec(resultLine?.slice(url.length) ?? "");
			assert.ok(match, `search finds the requirement in:\n${found}`);
			const line = Number(match[1]);
			assert.ok(line < (boundaryEntryOf(session) ?? 0), "the match is before the boundary");
			const opened = await read(`${url}:${line}-${line}`);
			assert.ok(opened.includes(REQUIREMENT), `read opens the requirement in:\n${opened}`);
			const tagged = await search("keepContext", url);
			assert.ok(tagged.includes("<keepContext>"), `search finds the tagged span in:\n${tagged}`);
		});
	}

	function boundaryEntryOf(session: AgentSession): number | undefined {
		const entry = session.sessionManager.getBranch().find((candidate) => candidate.type === "compaction");
		return (entry as { details?: { history?: { boundaryEntry?: number } } } | undefined)?.details?.history
			?.boundaryEntry;
	}

	it("a broad history search skips the current session, so the prompt names its exact URL", async () => {
		const { session, cwd, result } = await clearedSession(STORES[1]);
		const { search } = tools(session, cwd);
		const broad = await search("needle-4568", "history://sessions");
		assert.ok(!broad.includes(REQUIREMENT), `a broad search reached the current session:\n${broad}`);
		assert.ok(result.compactedText.includes(`search\` with paths "history://sessions/${session.sessionId}"`));
		assert.ok(result.compactedText.includes('a plain "history://sessions" search skips this session'));
	});

	it("tells the agent how to open a tool's full output", async () => {
		const { result } = await clearedSession(STORES[0]);
		assert.ok(result.compactedText.includes('"Full output saved to: <location>"'));
		assert.ok(result.compactedText.includes("tool-output:// or artifact:// URL"));
	});

	it("reaches the current session even when the router runs in another directory", async () => {
		const { session } = await clearedSession(STORES[1]);
		const elsewhere = mkdtempSync(join(tmpdir(), "atomic-history-recovery-other-"));
		cleanups.push(async () => rmSync(elsewhere, { recursive: true, force: true }));
		const url = `history://sessions/${session.sessionId}`;
		const found = await tools(session, elsewhere).search("needle-4568", url);
		assert.ok(found.includes(REQUIREMENT), found);
	});
});
