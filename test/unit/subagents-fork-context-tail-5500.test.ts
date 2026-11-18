/**
 * #5500: a forked subagent copied its parent's whole branch into its session and held it for its whole life, although
 * its context is only what follows the parent's latest clear or compaction. A fork of a long session now copies what
 * its context is built from, the entries a tail resume of the parent at the fork point loads, and reads no more of the
 * parent than that. The child's context is still exactly the parent's at the fork point, followed by the launch's
 * tool result.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { forkStageSession, STAGE_FORK_TOOL_RESULT } from "../../packages/workflows/src/shared/stage-session-store.js";

/** Turns of the parent before its context was cleared: its history, which no fork's context reads. */
const TURNS_BEFORE_CLEAR = 1_500;
/** Turns after the clear, up to the one that launches the fork. */
const TURNS_AFTER_CLEAR = 12;
/**
 * The most entries a fork of this parent may hold or write: the boundary, the turns after it, the settings a resume of
 * the parent keeps from before the boundary, and the tool result the fork appends. Independent of the history's length.
 */
const FORK_ENTRY_BUDGET = 2 * TURNS_AFTER_CLEAR + 16;
const FORK_CALL_ID = "toolu_fork_5500";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string, toolCall?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(toolCall === undefined
				? []
				: [{ type: "toolCall" as const, id: toolCall, name: "subagent", arguments: { context: "fork" } }]),
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-5",
		usage,
		stopReason: toolCall === undefined ? "stop" : "toolUse",
		timestamp: Date.now(),
	};
}

const cleared: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 7,
	parameters: { query: "clear" },
	form: "cleared",
	stats: {
		linesBefore: 10,
		linesDeleted: 10,
		linesKept: 0,
		rangeCount: 0,
		tokensBefore: 100_000,
		tokensAfter: 100,
		percentReduction: 99,
	},
};

/**
 * A long-running main session: a long history with its model and thinking settings, stored as it was written, then a
 * clear and the latest turns appended by the session itself. Returned as a live host holds it, opened as a resume does.
 */
async function longParent(store: SqlSessionStore): Promise<SessionManager> {
	const stamp = new Date().toISOString();
	const history: SessionEntry[] = [];
	const push = (entry: Record<string, unknown> & { readonly id: string }): void => {
		history.push({ ...entry, parentId: history.at(-1)?.id ?? null, timestamp: stamp } as unknown as SessionEntry);
	};
	push({ type: "model_change", id: "model", provider: "anthropic", modelId: "claude-opus-4-5" });
	push({ type: "thinking_level_change", id: "thinking", thinkingLevel: "high" });
	for (let turn = 0; turn < TURNS_BEFORE_CLEAR; turn++) {
		push({
			type: "message",
			id: `u${turn}`,
			message: { role: "user", content: `earlier request ${turn}`, timestamp: 1 },
		});
		push({ type: "message", id: `a${turn}`, message: assistant(`earlier answer ${turn} ${"x".repeat(400)}`) });
	}
	const sessionId = "long-parent-5500";
	await store.create({ id: sessionId, version: 4, createdAt: stamp, cwd: process.cwd() }, history);
	const writer = await SessionManager.open(store, sessionId, process.cwd(), { history: "tail" });
	await writer.appendCompaction("Context cleared.", null, 100_000, cleared);
	for (let turn = 0; turn < TURNS_AFTER_CLEAR; turn++) {
		await writer.appendMessage({ role: "user", content: `current request ${turn}`, timestamp: Date.now() });
		const last = turn === TURNS_AFTER_CLEAR - 1;
		await writer.appendMessage(assistant(`current answer ${turn}`, last ? FORK_CALL_ID : undefined));
	}
	return SessionManager.open(store, sessionId, process.cwd(), { history: "tail" });
}

async function sqlStore(): Promise<SqlSessionStore> {
	const dir = await mkdtemp(join(tmpdir(), "fork-context-tail-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
	const db = await openNodeSqliteDatabase(join(dir, "sessions.sqlite"));
	cleanups.push(() => db.close());
	const store = await SqlSessionStore.open(db);
	cleanups.push(() => store.close());
	return store;
}

test("a forked subagent of a long session copies only the context it is built from, and reads no more of the parent (#5500)", async () => {
	const store = await sqlStore();
	const parent = await longParent(store);
	// The parent's context read from its whole history, as a fork that copied all of it saw it.
	const parentContext = (await SessionManager.open(store, parent.getSessionId())).buildSessionContext();
	const fullLoads = vi.spyOn(store, "load");

	const child = await createForkContextResolver(parent, "fork", {
		toolCallIds: [FORK_CALL_ID],
	}).sessionManagerForIndex(0);
	const parentLoads = fullLoads.mock.calls.filter(([sessionId]) => sessionId === parent.getSessionId()).length;
	fullLoads.mockRestore();

	assert.ok(child);
	const childContext = child.buildSessionContext();
	assert.deepEqual(
		childContext.messages.slice(0, parentContext.messages.length),
		parentContext.messages,
		"the child's context starts with exactly the parent's at the fork point",
	);
	assert.deepEqual(
		childContext.messages.slice(parentContext.messages.length).map((message) => message.role),
		["toolResult"],
		"then the launch's tool result, and nothing else",
	);
	assert.deepEqual(
		[childContext.model, childContext.thinkingLevel],
		[parentContext.model, parentContext.thinkingLevel],
		"the child keeps the parent's model and thinking settings from before the clear",
	);
	const held = child.getEntries().length;
	const written = (await store.load(child.getSessionId())).entries.length;
	const parentEntries = (await store.load(parent.getSessionId())).entries.length;
	assert.ok(
		held <= FORK_ENTRY_BUDGET && written <= FORK_ENTRY_BUDGET,
		`a fork of a ${parentEntries}-entry parent held ${held} and wrote ${written} entries (budget ${FORK_ENTRY_BUDGET})`,
	);
	assert.equal(parentLoads, 0, "building the fork read the parent's whole history");
});

test("a workflow stage forked from a long stage session copies only the context it is built from (#5500)", async () => {
	const store = await sqlStore();
	const source = await longParent(store);
	const forkPoint = source.getLeafId();
	assert.ok(forkPoint);
	const sourceContext = (await SessionManager.open(store, source.getSessionId())).buildSessionContext();
	const fullLoads = vi.spyOn(store, "load");

	const stage = await forkStageSession(
		store,
		source.getSessionId(),
		process.cwd(),
		{ workflow: { runId: "run-5500", stageId: "forked", stageName: "forked" } },
		undefined,
		forkPoint,
	);
	const sourceLoads = fullLoads.mock.calls.filter(([sessionId]) => sessionId === source.getSessionId()).length;
	fullLoads.mockRestore();

	const stageContext = stage.buildSessionContext();
	assert.deepEqual(stageContext.messages.slice(0, sourceContext.messages.length), sourceContext.messages);
	assert.deepEqual(
		stageContext.messages
			.slice(sourceContext.messages.length)
			.map((message) => (message.role === "toolResult" ? message.content : message.role)),
		[[{ type: "text", text: STAGE_FORK_TOOL_RESULT }]],
	);
	assert.deepEqual(
		[stageContext.model, stageContext.thinkingLevel],
		[sourceContext.model, sourceContext.thinkingLevel],
	);
	const written = (await store.load(stage.getSessionId())).entries.length;
	assert.ok(
		written <= FORK_ENTRY_BUDGET,
		`a fork of a ${(await store.load(source.getSessionId())).entries.length}-entry stage session wrote ${written} entries (budget ${FORK_ENTRY_BUDGET})`,
	);
	assert.equal(sourceLoads, 0, "building the fork read the source's whole history");
});
