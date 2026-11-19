import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getSessionStats } from "../../src/core/agent-session-export.ts";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/compaction-types.js";
import { SessionManager } from "../../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";
import type { SessionResume, SessionStore } from "../../src/core/storage/session/types.js";
import { pendingTaskCompletionIntents } from "../../src/core/tasks/completion.ts";

const details: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 6,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	rung: "planned",
};

function usage(tokens: number): Usage {
	return {
		input: tokens,
		output: 1,
		cacheRead: 2,
		cacheWrite: 3,
		totalTokens: tokens + 6,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 128 },
	};
}

function assistant(text: string, tokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: `call-${text}`, name: "read", arguments: {} },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: usage(tokens),
		stopReason: "toolUse",
		timestamp: 1,
	};
}

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function sqlStore(): Promise<SessionStore> {
	const directory = mkdtempSync(join(tmpdir(), "atomic-tail-resume-"));
	directories.push(directory);
	const database = await openNodeSqliteDatabase(join(directory, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	closers.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

async function compactedSession(store: SessionStore, history = 4): Promise<{ id: string; firstPreTail: string }> {
	const manager = await SessionManager.create(store, "/project");
	await manager.appendModelChange("anthropic", "first-model");
	await manager.appendThinkingLevelChange("high");
	const firstPreTail = await manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	await manager.appendLabelChange(firstPreTail, "start");
	await manager.appendSessionInfo("named");
	await manager.appendCustomEntry("workspace_binding", { kind: "bound-workspace", worktree: "/p" });
	await manager.appendCustomEntry("task-completion-intent", { completionId: "settled" });
	await manager.appendCustomEntry("task-completion-ack", { completionId: "settled" });
	await manager.appendCustomEntry("task-completion-intent", { completionId: "open" });
	await manager.appendUsage("summary", "anthropic", "side-model", usage(32));
	for (let turn = 0; turn < history; turn++) {
		await manager.appendMessage({ role: "user", content: `question ${turn}`, timestamp: 1 });
		await manager.appendMessage(assistant(`answer-${turn}`, 128));
	}
	await manager.appendSessionInfo("renamed");
	const kept = await manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
	await manager.appendMessage(assistant("kept-answer", 256));
	await manager.appendCompaction("compacted history", kept, 1000, details, usage(64));
	await manager.appendMessage({ role: "user", content: "after", timestamp: 1 });
	await manager.appendMessage(assistant("after-answer", 512));
	return { id: manager.getSessionId(), firstPreTail };
}

function stats(manager: SessionManager) {
	return getSessionStats.call({
		sessionManager: manager,
		sessionFile: undefined,
		sessionId: manager.getSessionId(),
		getContextUsage: () => undefined,
	} as unknown as AgentSession);
}

describe("SessionManager resume from the latest compaction (#5249)", () => {
	it("resumes with the same context, name, labels, model, thinking level and usage as a whole read (#5249)", async () => {
		const store = await sqlStore();
		const { id, firstPreTail } = await compactedSession(store);
		const full = await SessionManager.open(store, id);
		const tail = await SessionManager.open(store, id, undefined, { history: "tail" });

		expect(full.hasFullHistory()).toBe(true);
		expect(tail.hasFullHistory()).toBe(false);
		expect(tail.getEntries().length).toBeLessThan(full.getEntries().length);
		expect(tail.buildSessionContext()).toEqual(full.buildSessionContext());
		expect(tail.buildSessionContext().thinkingLevel).toBe("high");
		expect(tail.getSessionNameState()).toEqual({ hasName: true, name: "renamed" });
		expect(tail.getLabel(firstPreTail)).toBe("start");
		expect(tail.getLeafId()).toBe(full.getLeafId());
		expect(tail.getHeader()).toEqual(full.getHeader());
		expect(tail.getBranch().some((entry) => entry.type === "thinking_level_change")).toBe(true);
		expect(pendingTaskCompletionIntents(tail)).toEqual(pendingTaskCompletionIntents(full));
		expect(pendingTaskCompletionIntents(tail).map((intent) => intent.completionId)).toEqual(["open"]);
		expect(
			tail.getEntries().some((entry) => entry.type === "custom" && entry.customType === "workspace_binding"),
		).toBe(true);
		const { contextUsage: _tailContext, ...tailStats } = stats(tail);
		const { contextUsage: _fullContext, ...fullStats } = stats(full);
		expect(tailStats).toEqual(fullStats);
	});

	it("reads only the tail and the state before it, however long the history (#5249)", async () => {
		const read = async (history: number) => {
			const store = await sqlStore();
			const { id } = await compactedSession(store, history);
			const tails: SessionResume[] = [];
			const counting: SessionStore = Object.assign(Object.create(store) as SessionStore, {
				load: () => Promise.reject(new Error("a resume must not load the whole session")),
				readResume: async (sessionId: string) => {
					const tail = await store.readResume!(sessionId);
					tails.push(tail);
					return tail;
				},
			});
			const manager = await SessionManager.open(counting, id, undefined, { history: "tail" });
			expect(tails).toHaveLength(1);
			return { entries: manager.getEntries().length, read: tails[0]!.state.length + tails[0]!.branch.length };
		};
		const short = await read(4);
		const long = await read(200);
		expect(long).toEqual(short);
	});

	it("reads older entries when the tree, a branch, a label or a fork needs them (#5249)", async () => {
		const store = await sqlStore();
		const { id, firstPreTail } = await compactedSession(store);
		const full = await SessionManager.open(store, id);

		const forTree = await SessionManager.open(store, id, undefined, { history: "tail" });
		await forTree.loadFullHistory();
		expect(forTree.hasFullHistory()).toBe(true);
		expect(forTree.getEntries()).toEqual(full.getEntries());
		expect(forTree.getTree()).toEqual(full.getTree());
		expect(forTree.getOmittedHistoryTotals()).toBeUndefined();

		const forLabel = await SessionManager.open(store, id, undefined, { history: "tail" });
		expect(forLabel.getEntry(firstPreTail)).toBeUndefined();
		await forLabel.appendLabelChange(firstPreTail, "again");
		expect(forLabel.getLabel(firstPreTail)).toBe("again");

		const forBranch = await SessionManager.open(store, id, undefined, { history: "tail" });
		await forBranch.branch(firstPreTail);
		expect(forBranch.getBranch().map((entry) => entry.id)).toEqual(
			full.getBranch(firstPreTail).map((entry) => entry.id),
		);

		const shape = (manager: SessionManager) =>
			manager.getEntries().map((entry) => (entry.type === "label" ? [entry.targetId, entry.label] : entry.id));
		const forFork = await SessionManager.open(store, id, undefined, { history: "tail" });
		await forFork.createBranchedSession(firstPreTail);
		const wholeFork = await SessionManager.open(store, id);
		await wholeFork.createBranchedSession(firstPreTail);
		expect(shape(forFork)).toEqual(shape(wholeFork));
		expect(shape(forFork)).toContainEqual([firstPreTail, "again"]);
	});

	it("appends after a tail resume and reopens to the same session (#5249)", async () => {
		const store = await sqlStore();
		const { id } = await compactedSession(store);
		const tail = await SessionManager.open(store, id, undefined, { history: "tail" });
		const added = await tail.appendMessage({ role: "user", content: "later", timestamp: 1 });
		const reopened = await SessionManager.open(store, id);
		expect(reopened.getEntries().at(-1)?.id).toBe(added);
		const again = await SessionManager.open(store, id, undefined, { history: "tail" });
		expect(again.buildSessionContext()).toEqual(reopened.buildSessionContext());
	});

	it("keeps state from an abandoned branch off the branch it resumes (#5249)", async () => {
		const store = await sqlStore();
		const manager = await SessionManager.create(store, "/project");
		const root = await manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		await manager.appendMessage(assistant("root-answer", 8));
		await manager.appendThinkingLevelChange("low");
		await manager.branch(root);
		await manager.appendThinkingLevelChange("high");
		const kept = await manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		await manager.appendMessage(assistant("kept-answer", 8));
		await manager.appendCompaction("compacted", kept, 10, details);
		await manager.appendMessage({ role: "user", content: "after", timestamp: 1 });
		const id = manager.getSessionId();
		const full = await SessionManager.open(store, id);
		const tail = await SessionManager.open(store, id, undefined, { history: "tail" });
		expect(tail.hasFullHistory()).toBe(false);
		expect(tail.buildSessionContext()).toEqual(full.buildSessionContext());
		expect(tail.buildSessionContext().thinkingLevel).toBe("high");
		expect(tail.getBranch().filter((entry) => entry.type === "thinking_level_change")).toHaveLength(1);
	});
});
