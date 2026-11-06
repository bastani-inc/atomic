import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@bastani/atomic";
import { openNodeSqliteDatabase, type SessionStore, StorageProvider } from "@bastani/atomic/storage";
import { afterEach, test } from "vitest";
import { sessionBlobOutput, TOOL_OUTPUT_ENTRY_TYPE } from "../../packages/coding-agent/src/core/session-tool-output.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { redirectOversizedToolResult } from "../../packages/coding-agent/src/core/tools/oversized-tool-result.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from "../../packages/coding-agent/src/core/tools/tool-limits.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { WorkAttemptFencedError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { workerSessionStore } from "../../packages/workflows/src/workers/session-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OUTPUT = `BEGIN pooled output\n${"w".repeat(DEFAULT_MAX_RESULT_SIZE_CHARS + 1)}`;

/** A pool's session tables in a file, the worker's store over them, and the commits the worker sent. */
async function pooledStage(options: { readonly fenced?: boolean } = {}) {
	const directory = makeTempDirectory("pool-session-blobs-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "journal.sqlite");
	// As a local worker opens the pool's session tables: through the provider's `sqlite` selection and the pool prefix.
	const reader = await new StorageProvider().openSessionStore(
		{ kind: "sqlite", path, prefix: "wf_runs_pool_" },
		{ agentDir: "", domain: "sessions" },
	);
	cleanups.push(() => reader.close());
	await reader.create({ id: "stage-session", version: 4, createdAt: new Date(0).toISOString(), cwd: directory }, []);
	const sent: PoolMutation[] = [];
	const worker = workerSessionStore({
		reader,
		backend: {} as DurableWorkflowBackend,
		store: createStore(),
		root: "root",
		commit: async (mutation) => {
			sent.push(mutation);
			if (options.fenced) throw new WorkAttemptFencedError({ workId: "work", generation: 1 });
			assert.equal(mutation.kind, "session-append");
			if (mutation.kind !== "session-append") throw new Error("unreachable");
			return reader.append(mutation.sessionId, mutation.entries, { expectSeq: mutation.expectSeq });
		},
	});
	const manager = await SessionManager.open(worker, "stage-session", directory);
	return { manager, worker, reader, sent, path, directory };
}

async function spill(manager: SessionManager) {
	return redirectOversizedToolResult({
		toolName: "bash",
		toolCallId: "call-1",
		result: { content: [{ type: "text", text: OUTPUT }], details: undefined },
		isError: false,
		sessionId: manager.getSessionId(),
		persist: sessionBlobOutput(manager, "call-1"),
	});
}

test("a pooled stage's oversized result is stored in the pool's session tables, which its root then reads (#4379)", async () => {
	const { manager, worker, sent, path } = await pooledStage();

	const replacement = await spill(manager);

	const message = replacement?.content[0];
	assert.ok(message?.type === "text");
	const location = /Full output saved to: (tool-output:\/\/[0-9a-f]{64})\n/.exec(message.text)?.[1];
	assert.ok(location !== undefined, "the preview names a tool-output URL, not a file");
	const hash = location.slice("tool-output://".length);
	assert.deepEqual(
		sent.map((mutation) => mutation.kind),
		["session-append"],
		"only the reference entry travels through the pool's commit",
	);
	const [append] = sent;
	assert.ok(append?.kind === "session-append");
	assert.deepEqual(
		append.entries.map((entry) => (entry.type === "custom" ? [entry.customType, entry.data] : entry.type)),
		[[TOOL_OUTPUT_ENTRY_TYPE, { toolCallId: "call-1", hash, bytes: Buffer.byteLength(OUTPUT) }]],
	);
	const rootDatabase = await openNodeSqliteDatabase(path);
	cleanups.push(() => rootDatabase.close());
	const root = await SqlSessionStore.open(rootDatabase, { prefix: "wf_runs_pool_" });
	assert.ok(
		Number((await rootDatabase.get<{ n: number }>("SELECT count(*) AS n FROM wf_runs_pool_session_blob_chunks"))?.n) >
			0,
	);
	assert.equal(Buffer.from((await root.getBlob("stage-session", hash))!).toString("utf8"), OUTPUT);
	assert.equal(Buffer.from((await worker.getBlob!("stage-session", hash))!).toString("utf8"), OUTPUT);
	assert.equal(
		(await root.load("stage-session")).entries.filter(
			(entry) => entry.type === "custom" && entry.customType === TOOL_OUTPUT_ENTRY_TYPE,
		).length,
		1,
	);
});

test("a fenced attempt's append fails the result and leaves no reference to the blob it wrote (#4379)", async () => {
	const { manager, reader } = await pooledStage({ fenced: true });

	await assert.rejects(spill(manager), (error) => error instanceof WorkAttemptFencedError);

	assert.deepEqual((await reader.load("stage-session")).entries, []);
});

test("a worker has blobs only over a reader that has both blob methods, so its results otherwise spill as files (#4379)", () => {
	const store = (reader: Partial<SessionStore>) =>
		workerSessionStore({
			reader: { descriptor: { adapter: "custom", location: "pool" }, ...reader } as SessionStore,
			backend: {} as DurableWorkflowBackend,
			store: createStore(),
			root: "root",
			commit: async () => ({ lastSeq: 1 }),
		});
	const putBlob = async () => ({ hash: "h", bytes: 0 });
	const getBlob = async () => undefined;

	for (const reader of [{}, { putBlob }, { getBlob }]) {
		const worker = store(reader);
		assert.equal(worker.putBlob, undefined, Object.keys(reader).join(", ") || "neither");
		assert.equal(worker.getBlob, undefined, Object.keys(reader).join(", ") || "neither");
	}
	const both = store({ putBlob, getBlob });
	assert.equal(typeof both.putBlob, "function");
	assert.equal(typeof both.getBlob, "function");
});
