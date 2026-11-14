/**
 * Which attempts of a pooled child count toward its attempt limit (#4768): an attempt the shared store's refusals
 * handed on does not, wherever the pool counts (a worker's exit, a fenced attempt); a write no host can ever make
 * does, so its child fails after the limit with an error that names the refusal instead of moving between hosts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import {
	openSqlPoolQueue,
	type PoolWork,
	SqlPoolQueue,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const BUDGET = poolTestBudgetMs(2);

/** A refusal no host gets through: sqld's answer to a response past its size limit. */
const tooLarge = () =>
	new StorageUnavailableError(
		{ adapter: "libsql", location: "http://127.0.0.1:1" },
		Object.assign(new Error("RESPONSE_TOO_LARGE: Response is too large"), { code: "RESPONSE_TOO_LARGE" }),
	);

/** Runs one pooled child of `exportName` in `fixture` under `fault`; its outcome and its work item after the run. */
async function runOneChild(
	fixture: string,
	exportName: string,
	fault: (database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>) => void,
	/** A stand-in worker module instead of the real worker. */
	workerEntry?: string,
) {
	const directory = makeTempDirectory("pool-attempt-counting-");
	const path = join(directory, "journal.sqlite");
	const childPath = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	let outcome: { status: string; error?: string } | undefined;
	const parent = workflow({
		name: "pool-attempt-counting-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			try {
				const result = await ctx.workflow(child, { inputs: { directory } });
				outcome = { status: result.status };
			} catch (error) {
				const chain: string[] = [];
				for (
					let e = error as Error | undefined, depth = 0;
					e && depth < 8;
					e = e.cause as Error | undefined, depth++
				)
					chain.push(
						`${e.name}: ${e.message}${(e as { code?: unknown }).code === undefined ? "" : ` [${String((e as { code?: unknown }).code)}]`}`,
					);
				outcome = { status: "rejected", error: chain.join(" <- ") };
			}
			return {};
		},
	});
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName }],
		coordinator: "in-process",
		...(workerEntry === undefined ? {} : { workerEntry }),
	});
	fault(database);
	const runId = randomUUID();
	try {
		const result = await run(
			parent,
			{},
			{
				runId,
				cwd: directory,
				store: createStore(),
				durableBackend: backend,
				signal: AbortSignal.timeout(BUDGET.waitMs),
			},
		);
		vi.restoreAllMocks();
		const items = await (await openSqlPoolQueue(journal)).inspect(runId);
		return { root: result.status, outcome, items };
	} finally {
		vi.restoreAllMocks();
		await pool.close().catch(() => {});
		await backend.close();
		await journal.close();
		await database.close();
		removeTempDirectory(directory);
	}
}

test.skipIf(process.platform === "win32")(
	"a child whose checkpoint no host can ever commit fails after its attempt limit, with an error naming the refusal (#4768)",
	async () => {
		const result = await runOneChild("pool-crash-once-child.ts", "crashOnceChild", () => {
			vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async () => {
				throw new StorageUnavailableError(
					{ adapter: "libsql", location: "http://127.0.0.1:1" },
					Object.assign(new Error("RESPONSE_TOO_LARGE: Response is too large"), { code: "RESPONSE_TOO_LARGE" }),
				);
			});
		});
		assert.equal(result.outcome?.status, "rejected", JSON.stringify(result));
		assert.match(result.outcome!.error!, /WorkerRetryLimitError/);
		assert.match(result.outcome!.error!, /RESPONSE_TOO_LARGE|Response is too large/);
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation, item.handoffs ?? []]),
			[["failed", 3, []]],
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"attempts the store handed on do not count when a later attempt's worker crashes (#4768)",
	async () => {
		const result = await runOneChild("pool-crash-once-child.ts", "crashOnceChild", () => {
			// The first two claims are handed on at once, as attempts the store's refusals ended would be.
			const claim = SqlPoolQueue.prototype.claim;
			let handedOn = 0;
			vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (
				this: SqlPoolQueue,
				...args: Parameters<SqlPoolQueue["claim"]>
			) {
				const work = (await claim.apply(this, args)) as PoolWork | undefined;
				if (work === undefined || handedOn >= 2) return work;
				handedOn++;
				await this.releaseExited(args[0], work, { delayMs: 0 });
				return undefined;
			});
		});
		assert.equal(result.outcome?.status, "completed", JSON.stringify(result));
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation, item.handoffs]),
			[["completed", 4, [1, 2]]],
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a resumed root counts only the handoffs of its own incarnation toward its child's attempt limit (#4768)",
	async () => {
		/** Attempts, all handed on, of the child's earlier incarnations: they belong to those, not to this one. */
		const EARLIER = 10;
		const result = await runOneChild("pool-crash-once-child.ts", "crashOnceChild", (database) => {
			const enqueue = SqlPoolQueue.prototype.enqueue;
			vi.spyOn(SqlPoolQueue.prototype, "enqueue").mockImplementation(async function (
				this: SqlPoolQueue,
				...args: Parameters<SqlPoolQueue["enqueue"]>
			) {
				const work = await enqueue.apply(this, args);
				// The work as a resumed root finds it: ready again after earlier incarnations handed it on EARLIER times.
				const [{ name }] = await database.all<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_pool_operations'",
				);
				const workTable = name.replace(/_pool_operations$/, "_work");
				await database.run(`UPDATE ${workTable} SET generation = ? WHERE id = ?`, EARLIER, work.id);
				for (let generation = 1; generation <= EARLIER; generation++)
					await database.run(
						`INSERT INTO ${name}(work, generation, operation, request, receipt) VALUES (?, ?, 'pool-handoff', 'pool-handoff', '{}')`,
						work.id,
						generation,
					);
				return { ...work, generation: EARLIER };
			});
			vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async () => {
				throw tooLarge();
			});
		});
		assert.equal(result.outcome?.status, "rejected", JSON.stringify(result));
		// Three attempts of this incarnation, the attempt limit: the earlier handoffs added none.
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation]),
			[["failed", EARLIER + 3]],
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"handoffs are capped: past the cap a handoff counts as an attempt, so a child no host gets through fails (#4768)",
	async () => {
		/** MAX_CHILD_HANDOFFS in pool-coordinator.ts. */
		const CAP = 20;
		const delays: number[] = [];
		const result = await runOneChild(
			"pool-crash-once-child.ts",
			"crashOnceChild",
			() => {
				// The growing wait before a handed-on child is claimable again is recorded, then skipped, to keep the test short.
				const releaseExited = SqlPoolQueue.prototype.releaseExited;
				vi.spyOn(SqlPoolQueue.prototype, "releaseExited").mockImplementation(function (
					this: SqlPoolQueue,
					lease,
					work,
					handoff,
				) {
					if (handoff !== undefined) delays.push(handoff.delayMs);
					return releaseExited.call(this, lease, work, handoff === undefined ? undefined : { delayMs: 0 });
				});
			},
			fileURLToPath(new URL("../fixtures/pool-handoff-stub-worker.mjs", import.meta.url)),
		);
		assert.equal(result.outcome?.status, "rejected", JSON.stringify(result.outcome));
		assert.match(result.outcome!.error!, /WorkerRetryLimitError/);
		assert.equal(delays.length, CAP);
		for (const [index, waited] of delays.entries())
			assert.ok(waited >= 0 && waited <= Math.min(30_000, 500 * 2 ** index), `handoff ${index} waited ${waited} ms`);
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation, item.handoffs?.length]),
			[["failed", CAP + 3, CAP]],
		);
	},
	BUDGET.timeoutMs,
);
