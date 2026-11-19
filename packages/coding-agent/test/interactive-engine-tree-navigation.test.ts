/**
 * `/tree` moves the session's leaf in the engine. The host mirrors the engine's session for the chat, the tree cursor,
 * `/clone`, `/session` and the context indicator, so it must follow the move at once. A move without a summary must
 * also survive reopening the session, or quitting, resuming or an engine recovery restores the abandoned turns into
 * the next request (#3325).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { getEngineSessionStats } from "../src/modes/interactive-engine/engine-session-stats.js";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.js";
import { getMessageText } from "./suite/harness.js";

let pair: EngineHostPair | undefined;
let sessionDir: string | undefined;

afterEach(async () => {
	await pair?.cleanup();
	pair = undefined;
	if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
	sessionDir = undefined;
});

const WORDS = ["alpha", "beta", "gamma", "delta"];
const FIRST_TWO_TURNS = [
	"user: Reply with exactly: alpha",
	"assistant: alpha",
	"user: Reply with exactly: beta",
	"assistant: beta",
];
/**
 * Saved sessions write each turn's user and assistant entries to SQLite on disk, and the host refreshes its stats over
 * the RPC pipe after the turn; under parallel shard load a turn can exceed `vi.waitFor`'s 1 s default.
 */
const ENGINE_TURN_SETTLE_TIMEOUT_MS = 10_000;

/** What the chat shows after `/tree`: the host session's context entries, as role/text pairs. */
function transcript(manager: Pick<SessionManager, "buildContextEntries">): string[] {
	return manager.buildContextEntries().flatMap((entry) => {
		if (entry.type === "branch_summary") return [`branch summary: ${entry.summary.split("\n").at(-1)}`];
		return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")
			? [`${entry.message.role}: ${getMessageText(entry.message)}`]
			: [];
	});
}

function messageTranscript(session: AgentSession): string[] {
	return session.messages.flatMap((message) =>
		message.role === "user" || message.role === "assistant" ? [`${message.role}: ${getMessageText(message)}`] : [],
	);
}

async function sendTurn(current: EngineHostPair, text: string): Promise<void> {
	await current.runtime.session.prompt(text);
	await vi.waitFor(() => assert.equal(current.engine.session.isStreaming, false), {
		timeout: ENGINE_TURN_SETTLE_TIMEOUT_MS,
	});
	await current.drain();
	// The host rereads the session from its store after the turn's `agent_end`. That read is not traffic `drain()`
	// waits for, and on a loaded machine it lands after `drain()` resolves, so wait until the host shows the turn.
	await vi.waitFor(
		() =>
			assert.equal(
				current.runtime.session.sessionManager.getLeafId(),
				current.engine.session.sessionManager.getLeafId(),
			),
		{ timeout: ENGINE_TURN_SETTLE_TIMEOUT_MS },
	);
}

async function startFourTurnSession(current: EngineHostPair): Promise<void> {
	current.engine.setResponses(WORDS.map((word) => fauxAssistantMessage(word)));
	await current.engine.session.bindExtensions({ shutdownHandler: () => {} });
	await current.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	await current.runtime.initializeFromEngine();
	for (const word of WORDS) await sendTurn(current, `Reply with exactly: ${word}`);
}

/** The id of the assistant reply to the second turn, the entry `/tree` selects in #3325. */
function betaReplyId(manager: SessionManager): string {
	const entry = manager
		.getEntries()
		.find(
			(candidate) =>
				candidate.type === "message" &&
				candidate.message.role === "assistant" &&
				getMessageText(candidate.message) === "beta",
		);
	assert.ok(entry, "the session has the reply to the second turn");
	return entry.id;
}

async function createSavedPair(
	engineExtensions?: ExtensionFactory[],
): Promise<{ current: EngineHostPair; engineManager: SessionManager }> {
	sessionDir = mkdtempSync(join(tmpdir(), "atomic-3325-"));
	const engineManager = await SessionManager.create(sessionDir, sessionDir);
	const current = await createEngineHostPair({
		sessionManager: engineManager,
		engineExtensions,
		hostSessionManager: await SessionManager.open(engineManager.getSessionStore(), engineManager.getSessionId()),
	});
	return { current, engineManager };
}

async function assertHostFollowsBranch(current: EngineHostPair, expected: string[], leafId: string): Promise<void> {
	const host = current.runtime.session;
	assert.deepEqual(transcript(host.sessionManager), expected);
	assert.deepEqual(messageTranscript(host), messageTranscript(current.engine.session));
	assert.equal(host.sessionManager.getLeafId(), leafId, "the tree cursor and /clone use the selected entry");
	await vi.waitFor(
		() =>
			assert.deepEqual(
				getEngineSessionStats(host)?.contextUsage,
				JSON.parse(JSON.stringify(current.engine.session.getSessionStats().contextUsage)),
			),
		{ timeout: ENGINE_TURN_SETTLE_TIMEOUT_MS },
	);
}

test("an unsaved isolated host keeps its private archive and can append locally after its engine store closes (#5554)", async () => {
	const stamp = new Date(0).toISOString();
	const manager = await SessionManager.inMemory("/project", { id: "engine" }, [
		{ type: "session", id: "engine", version: 4, cwd: "/project", createdAt: stamp },
		{
			type: "message",
			id: "old",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "old archive", timestamp: 1 },
		},
		{
			type: "compaction",
			id: "clear",
			parentId: "old",
			timestamp: stamp,
			summary: "clear",
			tokensBefore: 100,
			firstKeptEntryId: null,
			details: { strategy: "verbatim-lines" },
		},
		{
			type: "message",
			id: "now",
			parentId: "clear",
			timestamp: stamp,
			message: { role: "user", content: "current", timestamp: 2 },
		},
	]);
	pair = await createEngineHostPair({ sessionManager: manager });
	await pair.runtime.initializeFromEngine();
	const host = pair.runtime.session.sessionManager;
	assert.notEqual(host.getSessionStore(), manager.getSessionStore());
	await manager.getSessionStore().close();
	assert.equal(await host.findEntrySeq("old"), 1);
	assert.equal(host.getEntrySeq("now"), 3);
	await host.appendMessage({ role: "user", content: "local only", timestamp: 3 });
	assert.equal(host.getLastSeq(), 4);
	assert.equal(host.getLeafEntry()?.type, "message");
});

test("an unsaved host refresh reads only new engine rows and keeps an earlier host view independent (#5554)", async () => {
	const manager = SessionManager.inMemory("/project");
	for (let i = 0; i < 80; i++) await manager.appendMessage({ role: "user", content: `archived ${i}`, timestamp: i });
	await manager.appendCompaction("clear", null, 100, { strategy: "verbatim-lines" });
	const initial = await manager.appendMessage({ role: "user", content: "current", timestamp: 81 });
	pair = await createEngineHostPair({ sessionManager: manager });
	await pair.runtime.initializeFromEngine();
	const earlier = pair.runtime.session.sessionManager;
	assert.equal(earlier.getLeafId(), initial);
	const local = await earlier.appendMessage({ role: "user", content: "host local", timestamp: 82 });
	const next = await manager.appendMessage({ role: "user", content: "new engine turn", timestamp: 83 });
	const history = vi.spyOn(manager, "readHistory");
	await pair.runtime.initializeFromEngine();
	const current = pair.runtime.session.sessionManager;
	assert.equal(current.getLeafId(), next);
	assert.equal(await current.findEntrySeq(local), undefined);
	assert.equal(await earlier.findEntrySeq(next), undefined);
	for (const [options] of history.mock.calls) {
		const from = options?.fromSeq ?? Number(options?.cursor?.split(".")[1]);
		assert.ok(from > 82, `read an already mirrored row at ${from}`);
	}
});

test("a first private attachment exposes the current transcript even while its archive transfer is stopped (#5554)", async () => {
	const manager = SessionManager.inMemory("/project");
	await manager.appendMessage({ role: "user", content: "retired".repeat(200_000), timestamp: 1 });
	await manager.appendCompaction("clear", null, 100, { strategy: "verbatim-lines" });
	await manager.appendMessage({ role: "user", content: "current visible request", timestamp: 2 });
	pair = await createEngineHostPair({ sessionManager: manager });
	pair.failCommand("get_history_chunk", "transfer stopped");
	let preview: string[] = [];
	await assert.rejects(
		() =>
			pair!.runtime.initializeFromEngine(undefined, (lines: string[]) => {
				preview = lines;
			}),
		/transfer stopped/,
	);
	assert.deepEqual(preview, ["current visible request"]);
	assert.equal(
		pair.runtime.session.sessionManager.getEntryCount(),
		0,
		"a failed transfer must not publish the new manager",
	);
});

test("/tree with No summary shows only the selected branch in a saved session (#3325)", async () => {
	const { current, engineManager } = await createSavedPair();
	pair = current;
	await startFourTurnSession(current);
	const targetId = betaReplyId(engineManager);

	const result = await current.runtime.session.navigateTree(targetId, { summarize: false });
	await current.drain();

	assert.equal(result.cancelled, false);
	await assertHostFollowsBranch(current, FIRST_TWO_TURNS, targetId);
});

test("/tree with No summary shows only the selected branch in a --no-session session (#3325)", async () => {
	pair = await createEngineHostPair({});
	await startFourTurnSession(pair);
	const targetId = betaReplyId(pair.engine.session.sessionManager);

	await pair.runtime.session.navigateTree(targetId, { summarize: false });
	await pair.drain();

	await assertHostFollowsBranch(pair, FIRST_TWO_TURNS, targetId);
});

test("/tree with Summarize shows the branch summary in place of the abandoned turns (#3325)", async () => {
	const { current, engineManager } = await createSavedPair();
	pair = current;
	await startFourTurnSession(current);
	const targetId = betaReplyId(engineManager);
	current.engine.appendResponses([fauxAssistantMessage("The abandoned branch asked for gamma and delta.")]);

	const result = await current.runtime.session.navigateTree(targetId, { summarize: true });
	await current.drain();

	assert.ok(result.summaryEntry, "the engine wrote a branch summary");
	await assertHostFollowsBranch(
		current,
		[...FIRST_TWO_TURNS, "branch summary: The abandoned branch asked for gamma and delta."],
		result.summaryEntry.id,
	);
});

test("a No summary /tree move survives reopening the session before the next turn (#3325)", async () => {
	const { current, engineManager } = await createSavedPair();
	pair = current;
	await startFourTurnSession(current);
	const targetId = betaReplyId(engineManager);

	await current.runtime.session.navigateTree(targetId, { summarize: false });
	await current.drain();

	// Quitting and resuming, `--continue`, and an engine recovery all reopen the session from its store.
	const reopened = await SessionManager.open(engineManager.getSessionStore(), engineManager.getSessionId());
	assert.equal(reopened.getLeafId(), targetId);
	assert.deepEqual(transcript(reopened), FIRST_TWO_TURNS);
	const branching: string[] = [];
	const pending = reopened.getTree();
	for (let node = pending.pop(); node; node = pending.pop()) {
		if (node.children.length > 1) branching.push(node.entry.id);
		pending.push(...node.children);
	}
	assert.deepEqual(branching, [], "the recorded move adds no branch to the tree");
});

test("the next turn after a reopened No summary /tree move continues the selected branch (#3325)", async () => {
	const { current, engineManager } = await createSavedPair();
	pair = current;
	await startFourTurnSession(current);
	const targetId = betaReplyId(engineManager);
	await current.runtime.session.navigateTree(targetId, { summarize: false });
	await current.drain();

	const reopened = await SessionManager.open(engineManager.getSessionStore(), engineManager.getSessionId());
	await reopened.appendMessage({ role: "user", content: "Reply with exactly: epsilon", timestamp: Date.now() });

	const epsilon = reopened.getLeafEntry();
	assert.equal(epsilon?.parentId, targetId);
	assert.deepEqual(transcript(reopened), [...FIRST_TWO_TURNS, "user: Reply with exactly: epsilon"]);
});

test("a No summary /tree move to the start of the session survives reopening it (#3325)", async () => {
	const { current, engineManager } = await createSavedPair();
	pair = current;
	await startFourTurnSession(current);
	const firstUser = engineManager
		.getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.ok(firstUser);

	const result = await current.runtime.session.navigateTree(firstUser.id, { summarize: false });
	await current.drain();

	assert.equal(result.editorText, "Reply with exactly: alpha");
	assert.equal(current.runtime.session.sessionManager.getLeafId(), firstUser.parentId);
	const reopened = await SessionManager.open(engineManager.getSessionStore(), engineManager.getSessionId());
	assert.equal(reopened.getLeafId(), firstUser.parentId);
	assert.deepEqual(transcript(reopened), []);
});

test("Escape while /tree summarizes cancels the summary in the engine and keeps the branch (#3325)", async () => {
	let summarizing!: () => void;
	const started = new Promise<void>((resolve) => {
		summarizing = resolve;
	});
	// Holds the summary until the host cancels it, or lets it run after a while so the test fails rather than hangs.
	const holdSummary: ExtensionFactory = (pi) => {
		pi.on("session_before_tree", async (event) => {
			summarizing();
			await new Promise<void>((resolve) => {
				const fallback = setTimeout(resolve, ENGINE_TURN_SETTLE_TIMEOUT_MS);
				event.signal.addEventListener("abort", () => {
					clearTimeout(fallback);
					resolve();
				});
			});
		});
	};
	const { current, engineManager } = await createSavedPair([holdSummary]);
	pair = current;
	await startFourTurnSession(current);
	const targetId = betaReplyId(engineManager);
	current.engine.appendResponses([fauxAssistantMessage("A summary nobody asked for.")]);
	const leafBefore = engineManager.getLeafId();

	const navigation = current.runtime.session.navigateTree(targetId, { summarize: true });
	await started;
	current.runtime.session.abortBranchSummary();
	const result = await navigation;
	await current.drain();

	assert.deepEqual(
		{ cancelled: result.cancelled, aborted: result.aborted },
		{ cancelled: true, aborted: true },
		"the tree reopens with the same selection, as in pi",
	);
	assert.equal(engineManager.getLeafId(), leafBefore);
	assert.equal(current.runtime.session.sessionManager.getLeafId(), leafBefore, "the host keeps showing the branch");
});
