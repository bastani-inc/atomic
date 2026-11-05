import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { isJournalShardUnavailableError } from "@bastani/atomic/storage";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createDurableResumeRuntime } from "../../packages/workflows/src/extension/runtime-durable-resume.js";
import { createWorkflowBackgroundWarningReporter } from "../../packages/workflows/src/extension/workflow-background-warning.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";

let directory: string;
let store: string;
beforeEach(() => {
	directory = makeTempDirectory("workflow-unavailable-shards-");
	store = join(directory, "journal");
});
afterEach(() => removeTempDirectory(directory));

const open = () => ShardedRunJournal.open({ directory: store, openShard: (path) => openSqlRunJournal(path) });

async function storeWithLostShard(): Promise<JournalDurableBackend> {
	const first = await open();
	await first.createRun({ runId: "lost-run", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	const lost = first.shardOf("lost-run")!.path;
	await first.close();
	rmSync(lost);
	return JournalDurableBackend.open(await open());
}

test("the workflow catalog lists a native shard whose file was deleted, typed (#4325)", async () => {
	const backend = await storeWithLostShard();
	try {
		const catalog = await backend.prepareWorkflowCatalog();
		assert.equal(catalog.unavailableShards?.length, 1);
		const unavailable = catalog.unavailableShards?.[0];
		assert.ok(isJournalShardUnavailableError(unavailable));
		assert.deepEqual([unavailable.code, unavailable.retryable], ["shard-missing", false]);
		assert.ok(unavailable.hint.length > 0);
	} finally {
		await backend.close();
	}
});

test("a lost shard is logged once however often the catalog is read (#4325)", async () => {
	const backend = await storeWithLostShard();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		const runtime = createDurableResumeRuntime({
			registry: {} as never,
			store: createStore(),
			runtimeCwd: directory,
			ensureReady: async (): Promise<DurableWorkflowBackend> => backend,
			baseRunOpts: () => ({}),
			reportWarning: createWorkflowBackgroundWarningReporter({}),
		});
		assert.ok(runtime.prepareDurableCatalog);
		const first = await runtime.prepareDurableCatalog();
		await runtime.prepareDurableCatalog();
		assert.equal(first.unavailableShards?.length, 1);
		assert.equal(warn.mock.calls.length, 1);
		assert.ok(String(warn.mock.calls[0]?.[0]).includes("shard-missing"));
	} finally {
		warn.mockRestore();
		await backend.close();
	}
});

test("a healthy store adds no unavailable shards to the catalog (#4325)", async () => {
	const journal = await open();
	await journal.createRun({ runId: "fine", name: "wf", cwd: "/p", createdAt: 1, status: "failed" });
	const backend = await JournalDurableBackend.open(journal);
	try {
		const catalog = await backend.prepareWorkflowCatalog();
		assert.equal("unavailableShards" in catalog, false);
	} finally {
		await backend.close();
	}
});

test("reading the catalog without a warning reporter still works and still lists the lost shard (#4325)", async () => {
	const backend = await storeWithLostShard();
	try {
		const runtime = createDurableResumeRuntime({
			registry: {} as never,
			store: createStore(),
			runtimeCwd: directory,
			ensureReady: async (): Promise<DurableWorkflowBackend> => backend,
			baseRunOpts: () => ({}),
		});
		assert.ok(runtime.prepareDurableCatalog);
		assert.equal((await runtime.prepareDurableCatalog()).unavailableShards?.length, 1);
	} finally {
		await backend.close();
	}
});

test("the extension runtime reports a lost shard through the reporter it was given (#4325)", async () => {
	const backend = await storeWithLostShard();
	try {
		const activeStore = createStore();
		configureTestStoreBackend(activeStore, backend);
		const reported: string[] = [];
		const runtime = createExtensionRuntime({
			store: activeStore,
			reportWarning: (message) => reported.push(message),
		});
		await runtime.prepareDurableCatalog?.();
		assert.equal(reported.length, 1);
		assert.ok(reported[0]?.includes("shard-missing"));
	} finally {
		await backend.close();
	}
});
