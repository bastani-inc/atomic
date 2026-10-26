import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { type PoolCommitReceipt, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { fileExistsSync, makeTempDirectory, readTextSync, removeTempDirectory, sleep } from "../helpers/runtime.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

afterEach(() => {
	vi.restoreAllMocks();
});

const RECEIPT_POLL_MS = 25;
const COORDINATOR_RECEIPT_TEST_TIMEOUT_MS = 120_000;

/** Labels of the commit receipts the stub worker has recorded, in the order it received them. */
function receivedReceipts(path: string): string[] {
	if (!fileExistsSync(path)) return [];
	return readTextSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => (JSON.parse(line) as { readonly label: string }).label);
}

test(
	"the pool coordinator answers a session-append commit without refreshing usage, and a checkpoint commit after it (#3983)",
	async () => {
		const directory = makeTempDirectory("pool-commit-usage-receipt-");
		const path = join(directory, "journal.sqlite");
		const receipts = join(directory, "commit-receipts.log");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const childPath = fileURLToPath(new URL("../fixtures/pool-heartbeat-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		// The coordinator runs in this process so its journal calls can be intercepted; its worker is a protocol stub.
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
			workerEntry: fileURLToPath(new URL("../fixtures/pool-commit-receipt-stub-worker.mjs", import.meta.url)),
			coordinator: "in-process",
		});
		// The pool journal's own validation is not under test: each commit is recorded and answered with a receipt.
		const committed: PoolMutation["kind"][] = [];
		vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(
			async (_lease, _work, _operation, mutation): Promise<PoolCommitReceipt> => {
				committed.push(mutation.kind);
				return mutation.kind === "session-append" ? { at: 1, lastSeq: 1 } : { seq: 2, at: 1 };
			},
		);
		// Once a worker has committed, the usage-total read is held until the test releases it.
		const totalHeld = Promise.withResolvers<{ readonly committed: string[]; readonly received: string[] }>();
		const release = Promise.withResolvers<void>();
		const total = SqlPoolUsage.prototype.total;
		vi.spyOn(SqlPoolUsage.prototype, "total").mockImplementation(async function (this: SqlPoolUsage, root) {
			if (committed.length > 0) {
				totalHeld.resolve({ committed: [...committed], received: receivedReceipts(receipts) });
				await release.promise;
			}
			return total.call(this, root);
		});
		const execution = run(
			workflow({
				name: "pool-commit-usage-receipt-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.workflow(child, { inputs: { releasePath: join(directory, "release"), tools: 0 } });
					return {};
				},
			}),
			{},
			{ runId: "root", cwd: directory, store: createStore(), durableBackend: backend },
		);
		try {
			const held = await totalHeld.promise;
			// The usage refresh that holds the coordinator belongs to the checkpoint, not to the session append:
			// the append's receipt reached the worker without waiting on it.
			assert.deepEqual(held.committed, ["session-append", "checkpoint"]);
			assert.deepEqual(held.received, ["session-append"]);
			assert.deepEqual(receivedReceipts(receipts), ["session-append"], "the checkpoint waits on its usage refresh");
			release.resolve();
			while (receivedReceipts(receipts).length < 2) await sleep(RECEIPT_POLL_MS);
			assert.deepEqual(receivedReceipts(receipts), ["session-append", "checkpoint"]);
		} finally {
			release.resolve();
			vi.restoreAllMocks();
			await pool.close().catch(() => {});
			await execution.catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	COORDINATOR_RECEIPT_TEST_TIMEOUT_MS,
);
