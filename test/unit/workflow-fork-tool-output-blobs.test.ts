import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { sessionBlobOutput } from "../../packages/coding-agent/src/core/session-tool-output.js";
import {
	applySessionImport,
	exportSessions,
	planSessionImport,
	readSessionExports,
} from "../../packages/coding-agent/src/core/session-transfer.js";
import { isSessionBlobError, StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	readSessionHistory,
	readSessionHistoryChunks,
} from "../../packages/coding-agent/src/core/storage/session/history-pages.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	SESSION_HISTORY_CHUNK_BYTES,
	SESSION_HISTORY_PAGE_BYTES,
	type SessionStore,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { isForkCopyFailedError } from "../../packages/workflows/src/durable/fork-errors.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { forkStageSession } from "../../packages/workflows/src/shared/stage-session-store.js";
import { testRunId } from "../helpers/run-id.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

useTemporaryAgentDir();

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

const OUTPUT = "a released stage's whole output";
const HASH = createHash("sha256").update(OUTPUT, "utf8").digest("hex");

/** A stage session whose released stage kept `OUTPUT` as a blob, between two messages. */
async function stageSession(store: SessionStore) {
	const manager = await SessionManager.create(store, process.cwd());
	const before = await manager.appendMessage({ role: "user", content: "run it", timestamp: 1 });
	await sessionBlobOutput(manager, "call-1")!(OUTPUT);
	await manager.appendMessage({ role: "user", content: "after", timestamp: 2 });
	return { manager, before };
}

function clear(manager: SessionManager): Promise<string> {
	return manager.appendCompaction("cleared", null, 100, {
		strategy: "verbatim-lines",
		promptVersion: 7,
		parameters: { query: "clear" },
		form: "cleared",
		stats: {
			linesBefore: 1,
			linesDeleted: 1,
			linesKept: 0,
			rangeCount: 0,
			tokensBefore: 100,
			tokensAfter: 0,
			percentReduction: 100,
		},
	});
}

/** `store` without its blobs, as a custom store may be; `creates` counts the sessions it was asked to create. */
function blobless(store: SessionStore): SessionStore & { readonly creates: string[] } {
	const creates: string[] = [];
	return {
		creates,
		descriptor: { adapter: "custom", location: "custom" },
		create: (header, entries) => {
			creates.push(header.id);
			return store.create(header, entries);
		},
		append: (sessionId, entries, options) => store.append(sessionId, entries, options),
		replace: (sessionId, header, entries, options) => store.replace(sessionId, header, entries, options),
		load: (sessionId) => store.load(sessionId),
		readHeader: (sessionId) => store.readHeader(sessionId),
		delete: (sessionId) => store.delete(sessionId),
		list: (query) => store.list(query),
		findMostRecent: (query) => store.findMostRecent(query),
		close: () => store.close(),
	};
}

async function sessionIds(store: SessionStore): Promise<string[]> {
	const ids: string[] = [];
	for await (const summary of store.list({ includeInternal: true })) ids.push(summary.id);
	return ids;
}

test("a forked stage session holds the blobs its copied entries reference (#4379)", async () => {
	const source = new MemorySessionStore();
	const destination = new MemorySessionStore();
	const { manager, before } = await stageSession(source);

	const whole = await forkStageSession(source, manager.getSessionId(), process.cwd(), {}, destination);
	const atStart = await forkStageSession(source, manager.getSessionId(), process.cwd(), {}, destination, before);
	await source.delete(manager.getSessionId());

	assert.equal(Buffer.from((await destination.getBlob(whole.getSessionId(), HASH))!).toString(), OUTPUT);
	assert.equal(await destination.getBlob(atStart.getSessionId(), HASH), undefined, "the branch has no reference");
});

test("a fork includes a pre-boundary tool output actually named by its current input but no unrelated output (#5594)", async () => {
	const source = new MemorySessionStore(),
		dest = new MemorySessionStore();
	const p = await SessionManager.create(source, process.cwd());
	const referenced = await sessionBlobOutput(p, "saved-call")!(OUTPUT);
	const unrelated = await sessionBlobOutput(p, "unrelated-call")!("unreferenced historical blob");
	await clear(p);
	await p.appendMessage({
		role: "user",
		content: `Inspect ${referenced.location} from before the clear.`,
		timestamp: 3,
	});
	const c = await forkStageSession(source, p.getSessionId(), process.cwd(), {}, dest);
	await source.close();
	assert.equal(Buffer.from((await dest.getBlob(c.getSessionId(), referenced.sha256)) ?? []).toString(), OUTPUT);
	assert.equal(await dest.getBlob(c.getSessionId(), unrelated.sha256), undefined);
	await dest.close();
});

test("only a default current-leaf fork carries a named output from an earlier sibling branch (#5594)", async () => {
	const source = new MemorySessionStore();
	const destination = new MemorySessionStore();
	try {
		const parent = await SessionManager.create(source, process.cwd());
		const root = await parent.appendMessage({ role: "user", content: "root", timestamp: 0 });
		const named = await sessionBlobOutput(parent, "sibling-call")!(OUTPUT);
		const other = await sessionBlobOutput(parent, "sibling-other")!("not named");
		await parent.branch(root);
		await clear(parent);
		const leaf = await parent.appendMessage({ role: "user", content: `Read ${named.location}`, timestamp: 1 });
		const defaultFork = await forkStageSession(source, parent.getSessionId(), process.cwd(), {}, destination);
		const pointFork = await forkStageSession(source, parent.getSessionId(), process.cwd(), {}, destination, leaf);
		assert.equal(
			Buffer.from((await destination.getBlob(defaultFork.getSessionId(), named.sha256)) ?? []).toString(),
			OUTPUT,
		);
		assert.equal(await destination.getBlob(pointFork.getSessionId(), named.sha256), undefined);
		assert.equal(await destination.getBlob(defaultFork.getSessionId(), other.sha256), undefined);
		assert.equal(await destination.getBlob(pointFork.getSessionId(), other.sha256), undefined);
	} finally {
		await source.close();
		await destination.close();
	}
});

test("a fork preserves an opaque receipt's original parent link without losing the user turn before discarded workflow state (#5594)", async () => {
	const source = new MemorySessionStore();
	const dest = new MemorySessionStore();
	try {
		const parent = await SessionManager.create(source, process.cwd());
		await parent.appendMessage({ role: "user", timestamp: 0, content: "keep this user turn" });
		const omitted = await parent.appendCustomEntry("workflow.run.start", { runId: "owned", name: "parent", ts: 1 });
		await sessionBlobOutput(parent, "call")!(OUTPUT);
		const receipt = parent.getLeafEntry()!;
		await parent.appendMessage({ role: "user", timestamp: 1, content: "end" });
		const fork = await forkStageSession(source, parent.getSessionId(), process.cwd(), {}, dest);
		assert.deepEqual(fork.getEntry(receipt.id), receipt);
		assert.deepEqual(fork.buildSessionContext().messages, parent.buildSessionContext().messages);
		assert.equal(
			fork.getEntries().some((e) => e.type === "custom" && e.customType === "workflow.run.start"),
			false,
		);
		const dir = await mkdtemp(join(tmpdir(), "fork-receipt-backup-"));
		const restored = new MemorySessionStore();
		try {
			await exportSessions(dest, dir);
			const raw = await readFile(join(dir, `${fork.getSessionId()}.jsonl`), "utf8");
			assert.ok(
				raw.split("\n").includes(JSON.stringify(fork.getEntry(omitted))),
				"lossless backup omitted the exact structural link",
			);
			await applySessionImport(await planSessionImport(restored, await readSessionExports(dir)));
			const reopened = await SessionManager.open(restored, fork.getSessionId());
			assert.deepEqual(reopened.buildSessionContext().messages, parent.buildSessionContext().messages);
			assert.deepEqual(reopened.getEntry(receipt.id), receipt);
		} finally {
			await restored.close();
			await rm(dir, { recursive: true, force: true });
		}
	} finally {
		await source.close();
		await dest.close();
	}
});

test.each(["active", "retired"] as const)(
	"a fork preserves a large %s opaque receipt byte for byte and keeps it resident only in the active window (#5594)",
	async (location) => {
		const source = new MemorySessionStore();
		const dest = new MemorySessionStore();
		try {
			const parent = await SessionManager.create(source, process.cwd());
			const content = new TextEncoder().encode(OUTPUT);
			await source.putBlob(parent.getSessionId(), content);
			const metadata = "z".repeat(2 * 1024 * 1024);
			const receiptId = await parent.appendCustomEntry("atomic.tool-output", {
				toolCallId: "opaque",
				hash: HASH,
				bytes: content.length,
				privateMetadata: metadata,
			});
			const input = parent.getEntry(receiptId)!;
			const original = createHash("sha256").update(JSON.stringify(input)).digest("hex");
			if (location === "retired") await clear(parent);
			await parent.appendMessage({ role: "user", timestamp: 2, content: `Read tool-output://${HASH}` });
			const read = source.readRange.bind(source);
			let biggestReceiptRead = 0;
			source.readRange = async (...args) => {
				const page = await read(...args);
				for (const held of page.entries)
					if (held.id === receiptId)
						biggestReceiptRead = Math.max(biggestReceiptRead, Buffer.byteLength(JSON.stringify(held)));
				return page;
			};
			const fork = await forkStageSession(source, parent.getSessionId(), process.cwd(), {}, dest);
			const activeBytes = location === "active" ? Buffer.byteLength(JSON.stringify(input)) : 0;
			assert.deepEqual(fork.getEntry(receiptId), location === "active" ? input : undefined);
			assert.equal(
				fork.getEntries().some((e) => e.id === receiptId),
				location === "active",
			);
			const restored = createHash("sha256");
			for await (const page of readSessionHistory(dest, fork.getSessionId(), { fromSeq: 1, toSeq: 1 })) {
				const item = page.items[0]!;
				assert.ok("kind" in item && item.kind === "oversized");
				for await (const part of readSessionHistoryChunks(dest, item)) {
					assert.ok(part.byteLength <= SESSION_HISTORY_CHUNK_BYTES);
					restored.update(part);
				}
			}
			assert.equal(restored.digest("hex"), original);
			assert.deepEqual(await dest.getBlob(fork.getSessionId(), HASH), content);
			assert.ok(
				biggestReceiptRead <= Math.max(activeBytes, SESSION_HISTORY_PAGE_BYTES),
				`fork hydrated a ${biggestReceiptRead}-byte receipt`,
			);
		} finally {
			await source.close();
			await dest.close();
		}
	},
);

test("a stage session fork into a store that holds no blobs fails before it writes (#4379)", async () => {
	const source = new MemorySessionStore();
	const inner = new MemorySessionStore();
	const { manager } = await stageSession(source);

	const destination = blobless(inner);

	await assert.rejects(
		forkStageSession(source, manager.getSessionId(), process.cwd(), {}, destination),
		(error) => isSessionBlobError(error) && error.code === "blobs-unsupported" && error.adapter === "custom",
	);
	assert.deepEqual(destination.creates, []);
	assert.deepEqual(await sessionIds(inner), []);
});

async function forkedRun(destination: SessionStore, source = new MemorySessionStore()) {
	const backend = await createMemoryTestBackend();
	const { manager } = await stageSession(source);
	const def = workflow({
		name: "fork-tool-output",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("saved", { prompt: "saved" });
			await ctx.stage("next").complete("next");
			return {};
		},
	});
	const runId = testRunId("fork-tool-output-source");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: def.name,
		inputs: {},
		status: "completed",
		createdAt: 1,
		invocationCwd: join(process.cwd(), "source"),
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "task:stage:task:saved:1",
		name: "saved",
		replayKey: "stage:task:saved:1",
		sessionId: manager.getSessionId(),
		output: { name: "saved", stageName: "saved", text: "saved", sessionId: manager.getSessionId() },
		completedAt: 2,
	});
	await backend.commitCheckpoint({
		kind: "stage",
		workflowId: runId,
		checkpointId: "stage:stage:next:1",
		name: "next",
		replayKey: "stage:next:1",
		output: "next",
		completedAt: 3,
	});
	const fork = () =>
		forkDurableRun(backend, {
			source: "sdk",
			runId,
			fromStage: "next",
			cwd: process.cwd(),
			carryMessages: "before",
			definition: def,
			sessionStore: destination,
			sourceSessionStore: source,
		});
	return { backend, fork };
}

test("a forked run's copied stage sessions hold the blobs of the sessions they copy (#4379)", async () => {
	const destination = new MemorySessionStore();
	const { backend, fork } = await forkedRun(destination);

	const { runId } = await fork();

	const copied = backend.listCheckpoints(runId).find((checkpoint) => checkpoint.kind === "stage");
	assert.ok(copied?.kind === "stage" && copied.sessionId !== undefined);
	assert.equal(Buffer.from((await destination.getBlob(copied.sessionId, HASH))!).toString(), OUTPUT);
});

test("a forked run whose session store holds no blobs fails its copy and leaves no copied session (#4379)", async () => {
	const inner = new MemorySessionStore();
	const destination = blobless(inner);
	const { fork } = await forkedRun(destination);

	await assert.rejects(fork(), (error) => {
		assert.ok(isForkCopyFailedError(error));
		assert.ok(isSessionBlobError(error.cause));
		assert.equal(error.cause.code, "blobs-unsupported");
		return true;
	});
	assert.deepEqual(destination.creates, [], "the copy failed before it created a session");
	assert.deepEqual(await sessionIds(inner), []);
});

test("a source store that fails to read a blob fails the copy, which is retryable and leaves no copied session (#4379)", async () => {
	const source = new MemorySessionStore();
	const failure = new StorageUnavailableError(source.descriptor, new Error("disk read failed"));
	const destination = new MemorySessionStore();
	const { fork } = await forkedRun(destination, source);
	source.getBlob = async () => {
		throw failure;
	};

	await assert.rejects(fork(), (error) => {
		assert.ok(isForkCopyFailedError(error));
		assert.equal(error.retryable, true);
		assert.equal(error.cause, failure);
		return true;
	});
	assert.deepEqual(await sessionIds(destination), []);
});
