import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getSessionStats } from "../../src/core/agent-session-export.ts";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/compaction-types.js";
import {
	buildSessionProjection,
	getSessionLeafId,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { getBranchPath } from "../../src/core/session-manager-history.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";
import {
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	type SessionResume,
	type SessionStore,
} from "../../src/core/storage/session/types.js";
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

function stats(manager: Pick<SessionManager, "getEntries" | "getSessionId">) {
	return getSessionStats.call({
		sessionManager: manager,
		sessionFile: undefined,
		sessionId: manager.getSessionId(),
		getContextUsage: () => undefined,
	} as unknown as AgentSession);
}

it("a live manager drops earlier windows after each compaction without deleting their history (#5554)", async () => {
	const store = await sqlStore();
	const manager = await SessionManager.create(store, "/project");
	const windows = 3;
	const messagesPerWindow = 20;
	for (let window = 0; window < windows; window++) {
		for (let turn = 0; turn < messagesPerWindow; turn++) {
			await manager.appendMessage({ role: "user", content: `window ${window}, turn ${turn}`, timestamp: turn });
		}
		await manager.appendCompaction(`summary ${window}`, null, 1000, details);
		const reopened = await SessionManager.open(store, manager.getSessionId(), undefined, { history: "tail" });
		expect(manager.buildSessionContext()).toEqual(reopened.buildSessionContext());
		expect(manager.getEntryCount()).toBe(reopened.getEntryCount());
	}
	const first = await store.readRange!(manager.getSessionId(), 1, 1);
	expect(first.entries[0]).toMatchObject({ type: "message", message: { content: "window 0, turn 0" } });
	expect(first.lastSeq).toBe(windows * (messagesPerWindow + 1));
});

it("discovers interrupted workflows across a clear without keeping their inputs, outputs or closed runs (#5554)", async () => {
	const store = await sqlStore();
	const writer = await SessionManager.create(store, "/project");
	const payload = "界".repeat(SESSION_HISTORY_PAGE_BYTES);
	const runId = "active\ud800workflow";
	for (const id of ["completed", runId]) {
		await writer.appendCustomEntry("workflow.run.start", { inputs: { payload }, runId: id, name: "work", ts: 1 });
		await writer.appendCustomEntry("workflow.stage.end", { runId: id, output: payload });
	}
	await writer.appendCustomEntry("workflow.run.end", { runId: "completed" });
	await writer.appendCompaction("cleared", null, 1000, details);
	const resumed = await SessionManager.open(store, writer.getSessionId());
	for (const manager of [writer, resumed]) {
		expect(await manager.readOpenWorkflowIds()).toEqual([runId]);
		expect(manager.getEntries().map((entry) => entry.type)).toEqual(["compaction"]);
	}
	await resumed.appendCustomEntry("workflow.run.end", { runId });
	expect(await resumed.readOpenWorkflowIds()).toEqual([]);
});

it("a cleared parent releases a giant workflow identity after its route ends (#5554)", async () => {
	const store = await sqlStore();
	const parent = await SessionManager.create(store, "/project");
	const { collectGarbage } = await import("../../../../test/helpers/collect-garbage.js");
	const makeRun = async () => {
		const runId = Array.from({ length: 2048 }, () => "r".repeat(1024)).join("");
		const start = { runId, name: "work", ts: 1 };
		const end = { runId };
		const first = await parent.appendCustomEntry("workflow.run.start", start);
		await parent.appendCompaction("cleared", null, 1000, details);
		expect(await parent.readOpenWorkflowIds()).toEqual([runId]);
		const last = await parent.appendCustomEntry("workflow.run.end", end);
		await parent.appendCompaction("cleared again", null, 1000, details);
		return { entries: [first, last], payloads: [new WeakRef(start), new WeakRef(end)] };
	};
	const { entries, payloads } = await makeRun();
	await collectGarbage();
	expect(payloads.every((payload) => payload.deref() === undefined)).toBe(true);
	expect(entries.every((id) => !parent.getEntry(id))).toBe(true);
	expect(await parent.readOpenWorkflowIds()).toEqual([]);
	const resume = await store.readResume!(parent.getSessionId());
	expect(resume.recovery.workflowStarts).toEqual({});
	expect(JSON.stringify(resume).length).toBeLessThan(SESSION_HISTORY_PAGE_BYTES);
});

it("live stage and Intercom receipts survive repeated clears without retaining their message bodies (#5554)", async () => {
	const store = await sqlStore();
	const live = await SessionManager.create(store, "/project");
	for (const n of [1, 2]) {
		await live.appendCustomEntry("atomic-pooled-delivery-op", { op: `op${n}` });
		await live.appendCustomMessageEntry("intercom_message", `m${n}`, true, { message: { id: `m${n}` } });
		await live.appendCompaction(`clear${n}`, null, 100, details);
	}
	const reopened = await SessionManager.open(store, live.getSessionId());
	for (const holder of [live, reopened]) {
		const recovery = holder.getSessionRecoveryState();
		expect(recovery.intercomDeliveredIds).toEqual(["m1", "m2"]);
		expect(recovery.deliveryOpIds).toEqual(["op1", "op2"]);
		expect(holder.getEntries().map((entry) => entry.type)).toEqual(["compaction"]);
	}
});

it("moving to an older branch restores that window but does not hydrate abandoned conversations (#5554)", async () => {
	const store = await sqlStore();
	const { id, firstPreTail } = await compactedSession(store, 100);
	const session = await SessionManager.open(store, id),
		otherLeaf = session.getLeafId();
	await session.branchWithSummary(firstPreTail, "summary of the branch we left");
	const summary = session.getLeafEntry();
	expect(summary?.type === "branch_summary" && summary.fromId).toBe(otherLeaf);
	expect(session.getEntryCount()).toBeLessThan(30);
	expect(session.getBranch().at(-2)?.id).toBe(firstPreTail);
	expect(await session.findEntrySeq(otherLeaf!)).toBeDefined();
});

it("a default open reads the same window as a tail open without reading the whole store (#5554)", async () => {
	const store = await sqlStore();
	const { id, firstPreTail } = await compactedSession(store);
	const expected = await SessionManager.open(store, id, undefined, { history: "tail" });
	const guarded: SessionStore = Object.assign(Object.create(store) as SessionStore, {
		load: () => Promise.reject(new Error("opened the entire session")),
	});
	const manager = await SessionManager.open(guarded, id);
	expect(manager.getEntry(firstPreTail)).toBeUndefined();
	expect(manager.getEntries()).toEqual(expected.getEntries());
	expect(manager.buildSessionContext()).toEqual(expected.buildSessionContext());
});

it("an in-flight historical lookup never returns a different session's entry with the same ID (#5554)", async () => {
	const store = new MemorySessionStore();
	const manager = await SessionManager.create(store, "/project");
	const old = await manager.appendMessage({ role: "user", content: "original owner", timestamp: 1 });
	const raw = manager.getEntry(old)!;
	await manager.appendCompaction("cleared", null, 100, details);
	const original = manager.getSessionId();
	const found = Promise.withResolvers<void>(),
		finish = Promise.withResolvers<void>();
	const lookup = store.findEntrySeq.bind(store);
	store.findEntrySeq = async (sessionId, id) => {
		const seq = await lookup(sessionId, id);
		if (sessionId === original && id === old) {
			found.resolve();
			await finish.promise;
		}
		return seq;
	};
	try {
		const inFlight = manager.readEntry(old);
		await found.promise;
		await manager.newSession();
		await store.append(
			manager.getSessionId(),
			[
				{
					type: "message",
					id: old,
					parentId: null,
					timestamp: raw.timestamp,
					message: { role: "user", content: "different owner", timestamp: 2 },
				},
			],
			{ expectSeq: 0 },
		);
		await manager.refreshFromStore();
		finish.resolve();
		expect(await inFlight).toEqual(raw);
	} finally {
		finish.resolve();
		await store.close();
	}
});

it("labels a retired oversized entry without decoding it or accepting a different writer's future target (#5554)", async () => {
	const store = new MemorySessionStore();
	try {
		const manager = await SessionManager.create(store, "/project");
		const old = await manager.appendMessage({
			role: "user",
			content: "x".repeat(SESSION_HISTORY_PAGE_BYTES + 20),
			timestamp: 1,
		});
		await manager.appendCompaction("cleared", null, 100, details);
		await manager.appendLabelChange(old, "hello");
		expect(manager.getLabel(old)).toBe("hello");
		expect(manager.getEntry(old)).toBeUndefined();
		const peer = await SessionManager.open(store, manager.getSessionId());
		const future = await peer.appendMessage({ role: "user", content: "peer", timestamp: 2 });
		expect(await manager.findEntrySeq(future)).toBeUndefined();
	} finally {
		await store.close();
	}
});

it("a reader can stop after its first page without hydrating older messages into the manager (#5554)", async () => {
	const store = await sqlStore();
	const { id, firstPreTail } = await compactedSession(store, 120);
	const manager = await SessionManager.open(store, id);
	const held = manager.getEntryCount();
	const seen: number[] = [];
	read: for await (const { items } of manager.readHistory()) {
		for (const item of items) {
			seen.push(item.seq);
			if ("entry" in item && item.entry.id === firstPreTail) break read;
		}
	}
	expect(seen).toEqual([1, 2, 3]);
	expect(manager.getEntryCount()).toBe(held);
	expect(manager.getEntry(firstPreTail)).toBeUndefined();
});

it("a giant historical entry is an exact byte stream, never one decoded entry (#5554)", async () => {
	const store = await sqlStore();
	const writer = await SessionManager.create(store, "/project");
	const giant = "a".repeat(SESSION_HISTORY_PAGE_BYTES - 2) + "漢😀e\u0301".repeat(16);
	const id = await writer.appendMessage({ role: "user", timestamp: 0, content: giant });
	const expected = Buffer.from(JSON.stringify(writer.getEntry(id)));
	await writer.appendCompaction("cleared", null, 1000, details);
	const manager = await SessionManager.open(store, writer.getSessionId());
	const first = await manager.readHistory({ toSeq: 1 }).next();
	expect(first.done).toBe(false);
	const reference = first.value?.items[0];
	if (!reference || !("kind" in reference) || reference.kind !== "oversized")
		throw new Error("a history page decoded the giant entry");
	expect(reference.bytes).toBe(expected.length);
	let offset = 0;
	for await (const chunk of manager.readHistoryChunks(reference)) {
		expect(chunk.length).toBeGreaterThan(0);
		expect(chunk.length).toBeLessThanOrEqual(SESSION_HISTORY_CHUNK_BYTES);
		expect(Buffer.from(chunk).equals(expected.subarray(offset, offset + chunk.length))).toBe(true);
		offset += chunk.length;
	}
	expect(offset).toBe(expected.length);
	expect(manager.getEntry(id)).toBeUndefined();
});

it("2 MiB entry identities survive create, append, import, seed, copy and fork unchanged (#5554)", async () => {
	const store = await sqlStore();
	const dir = mkdtempSync(join(tmpdir(), "atomic-long-identity-"));
	directories.push(dir);
	const timestamp = new Date(0).toISOString();
	const header = { id: "long-ids", version: 4 as const, createdAt: timestamp, cwd: dir };
	const ids = ["a", "b"].map((char) => char.repeat(2 * 1024 * 1024));
	const entries: SessionEntry[] = ids.map((id, i) => ({
		type: "message",
		id,
		parentId: i ? ids[0]! : null,
		timestamp,
		message: { role: "user", content: `message ${i}`, timestamp: i },
	}));
	await store.create(header, [entries[0]!]);
	await store.append(header.id, [entries[1]!], { expectSeq: 1 });
	const source = await SessionManager.open(store, header.id);
	const file = join(dir, "export.jsonl");
	await writeFile(
		file,
		[{ type: "session", ...header }, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
	);
	const target = new MemorySessionStore();
	closers.push(() => target.close());
	const imported = await SessionManager.importFromJsonl(file, dir, target);
	const seeded = await SessionManager.inMemory(dir, undefined, entries);
	const forked = await source.forkTo(dir, target);
	const copied = new MemorySessionStore();
	closers.push(() => copied.close());
	await imported.rebindStore(copied, false);
	for (const manager of [source, imported, seeded, forked]) {
		const branch = manager.getBranch();
		expect(branch.length).toBe(2);
		expect(branch[0]!.id === ids[0] && branch[1]!.id === ids[1] && branch[1]!.parentId === ids[0]).toBe(true);
	}
	await source.appendCompaction("cleared", null, 100, details);
	const firstWindow = source.getEntries();
	expect(firstWindow.length).toBe(1);
	expect(firstWindow[0]!.parentId === ids[1]).toBe(true);
	await source.appendMessage({ role: "user", content: "later", timestamp: 3 });
	await source.appendCompaction("cleared again", null, 100, details);
	expect(source.getEntryCount()).toBe(1);
	expect(Buffer.byteLength(JSON.stringify(source.getEntries()))).toBeLessThan(4096);
	const result = await source.readHistory({ fromSeq: 2, toSeq: 2 }).next();
	const ref = result.value?.items[0];
	if (!ref || !("kind" in ref)) throw new Error("historical identity did not use a bounded entry reference");
	const chunks = [];
	for await (const chunk of source.readHistoryChunks(ref)) chunks.push(chunk);
	expect(Buffer.concat(chunks).equals(Buffer.from(JSON.stringify(entries[1])))).toBe(true);
});

it("a seeded private session yields while storing its input and initially owns only the current window (#5554)", async () => {
	const timestamp = new Date(0).toISOString();
	const history: SessionEntry[] = Array.from({ length: 400 }, (_, i) => ({
		type: "message",
		id: `old${i}`,
		parentId: i ? `old${i - 1}` : null,
		timestamp,
		message: { role: "user", content: `saved-${i}`, timestamp: 0 },
	}));
	history.push({
		type: "compaction",
		id: "boundary",
		parentId: history.at(-1)!.id,
		timestamp,
		details,
		summary: "cleared",
		tokensBefore: 1000,
		firstKeptEntryId: null,
	});
	let yielded = false;
	const turn = setImmediate(() => {
		yielded = true;
	});
	try {
		const manager = await SessionManager.inMemory("/project", undefined, history);
		expect(manager.getEntryCount()).toBe(1);
		expect(yielded).toBe(true);
		expect(manager.isPersisted()).toBe(false);
		expect(await manager.readEntry("old0")).toEqual(history[0]);
	} finally {
		clearImmediate(turn);
	}
});

it("a resume does not retain previous system instructions or superseded model settings (#5554)", async () => {
	const store = await sqlStore();
	const writer = await SessionManager.create(store, "/project");
	for (let i = 0; i < 32; i++) {
		await writer.appendModelChange("test", `model-${i}`);
		await writer.appendThinkingLevelChange(i % 2 ? "high" : "low");
		await writer.appendMessage({ role: "system", content: `instruction ${i}`, timestamp: i });
	}
	await writer.appendCompaction("cleared", null, 100, details);
	const manager = await SessionManager.open(store, writer.getSessionId());
	const kept = manager.getEntries();
	expect(kept.filter((e) => e.type === "model_change")).toHaveLength(1);
	expect(kept.filter((e) => e.type === "thinking_level_change")).toHaveLength(1);
	expect(kept.filter((e) => e.type === "message" && e.message.role === "system")).toHaveLength(0);
	const full = [...(await store.load(writer.getSessionId())).entries];
	expect(manager.buildSessionProjection()).toEqual(
		buildSessionProjection(full, writer.getLeafId(), undefined, writer.getSessionId()),
	);
});

it("a live window does not retain one identical checkout reference per old turn (#5554)", async () => {
	const store = await sqlStore();
	const writer = await SessionManager.create(store, "/project");
	const root = "/project";
	const snapshot = {
		id: "one",
		root,
		tree: "t",
		chain: [],
		omitted: [],
		filters: null,
		bundle: null,
	} as unknown as import("../../src/core/worktree-snapshot/types.js").WorktreeSnapshot;
	await writer.appendWorktreeSnapshot(root, snapshot.id, snapshot);
	for (let i = 0; i < 100; i++)
		await writer.appendWorktreeSnapshot(root, snapshot.id, undefined, undefined, undefined, undefined, i);
	await writer.appendCompaction("cleared", null, 100, details);
	const manager = await SessionManager.open(store, writer.getSessionId());
	for (const view of [writer, manager]) {
		expect(view.getEntries().filter((e) => e.type === "worktree_snapshot").length).toBeLessThanOrEqual(3);
		expect(view.getLatestWorktreeSnapshots().get(root)).toEqual(snapshot);
		expect(
			view
				.getEntries()
				.filter((e) => e.type === "worktree_snapshot")
				.at(-1)?.captureMs,
		).toBe(99);
	}
});

describe("SessionManager resume from the latest compaction (#5249)", () => {
	it("resumes with the same context, name, labels, model, thinking level and usage as a whole read (#5249)", async () => {
		const store = await sqlStore();
		const { id, firstPreTail } = await compactedSession(store);
		const snapshot = await store.load(id);
		const entries = [...snapshot.entries];
		const full = { getEntries: () => entries, getSessionId: () => id };
		const tail = await SessionManager.open(store, id, undefined, { history: "tail" });

		expect(tail.hasFullHistory()).toBe(false);
		expect(tail.getEntries().length).toBeLessThan(entries.length);
		expect(tail.buildSessionProjection()).toEqual(
			buildSessionProjection(entries, getSessionLeafId(entries), undefined, id),
		);
		expect(tail.buildSessionContext().thinkingLevel).toBe("high");
		expect(tail.getSessionNameState()).toEqual({ hasName: true, name: "renamed" });
		expect(tail.getLabel(firstPreTail)).toBe("start");
		expect(tail.getLeafId()).toBe(getSessionLeafId(entries));
		expect(tail.getHeader()).toEqual({ type: "session", ...snapshot.header });
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
		const full = [...(await store.load(id)).entries];
		const forTree = await SessionManager.open(store, id, undefined, { history: "tail" });
		const read: SessionEntry[] = [];
		for await (const { items } of forTree.readHistory()) {
			for (const item of items) if ("entry" in item) read.push(item.entry);
		}
		expect(read).toEqual(full);
		expect(forTree.hasFullHistory()).toBe(false);
		expect(forTree.getOmittedHistoryTotals()).toBeDefined();

		const forLabel = await SessionManager.open(store, id, undefined, { history: "tail" });
		expect(forLabel.getEntry(firstPreTail)).toBeUndefined();
		await forLabel.appendLabelChange(firstPreTail, "again");
		expect(forLabel.getLabel(firstPreTail)).toBe("again");

		const forBranch = await SessionManager.open(store, id, undefined, { history: "tail" });
		await forBranch.branch(firstPreTail);
		expect(forBranch.getBranch().map((entry) => entry.id)).toEqual(
			getBranchPath(firstPreTail, new Map(full.map((entry) => [entry.id, entry]))).map((entry) => entry.id),
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

	it("updates a session header without reading or rewriting its old entries (#5249, #5554)", async () => {
		const store = await sqlStore();
		const { id } = await compactedSession(store);
		const before = (await store.load(id)).entries;
		const tail = await SessionManager.open(store, id, undefined, { history: "tail" });
		const held = tail.getEntryCount();
		await tail.markSessionInternal({ runId: "run", stageId: "stage", stageName: "stage" });
		expect(tail.getEntryCount()).toBe(held);
		const after = await store.load(id);
		expect(after.entries).toEqual(before);
		expect(after.header.internal).toBe(true);
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
		const full = [...(await store.load(id)).entries];
		const tail = await SessionManager.open(store, id, undefined, { history: "tail" });
		expect(tail.hasFullHistory()).toBe(false);
		expect(tail.buildSessionProjection()).toEqual(
			buildSessionProjection(full, getSessionLeafId(full), undefined, id),
		);
		expect(tail.buildSessionContext().thinkingLevel).toBe("high");
		expect(tail.getBranch().filter((entry) => entry.type === "thinking_level_change")).toHaveLength(1);
	});
});
