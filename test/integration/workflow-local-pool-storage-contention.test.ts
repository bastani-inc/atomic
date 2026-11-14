/**
 * A pool's journal that keeps refusing writes for a while, as a database server whose write lock other hosts keep
 * busy does, must slow its pooled children down and never cost them an attempt (#4768): a checkpoint commit, claim or
 * completion that the storage refused is sent again within the attempt's lease. Only a lost lease hands the child to
 * another attempt.
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
import { openSqlPoolQueue, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import {
	makeTempDirectory,
	readDirectorySync,
	removeTempDirectory,
	sleep,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const WORKERS = 3;
const CHILDREN = 3;
/** Long enough that the refusals below fit within one lease many times over. */
const WORK_LEASE_MS = 20_000;
/** How many times in a row the journal refuses each write it refuses. */
const REFUSALS_IN_A_ROW = 3;
const childPath = fileURLToPath(new URL("../fixtures/pool-committing-child.ts", import.meta.url));
const BUDGET = poolTestBudgetMs(2);

/** A refusal as the libSQL adapter reports a write lock it could not take: nothing was written. */
function refused(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "libsql", location: "http://127.0.0.1:1" },
		Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" }),
	);
}

async function waitUntil(predicate: () => boolean, what: string, budget: AbortSignal): Promise<void> {
	while (!predicate()) {
		if (budget.aborted) throw new Error(`Timed out waiting for ${what}`);
		await sleep(20);
	}
}

/** `handedOn`: the fault hands each child to another attempt, so the attempt that finishes it need not have started it. */
async function runChildrenWhile(fault: () => void, handedOn = false): Promise<void> {
	const directory = makeTempDirectory("pool-storage-contention-");
	const path = join(directory, "journal.sqlite");
	const exportName = "committingChild";
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName,
		digest: await definitionDigest(childPath),
	});
	const children: {
		status: string;
		error?: string;
		firstPid?: WorkflowSerializableValue;
		finalPid?: WorkflowSerializableValue;
	}[] = [];
	const parent = workflow({
		name: "pool-storage-contention-root",
		description: "Root over pooled children while the pool's journal refuses some writes",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const results = await Promise.allSettled(
				Array.from({ length: CHILDREN }, (_, index) => ctx.workflow(child, { inputs: { directory, index } })),
			);
			for (const result of results)
				children.push(
					result.status === "rejected"
						? { status: "rejected", error: String(result.reason) }
						: {
								status: result.value.status,
								...(result.value.status === "completed"
									? { firstPid: result.value.outputs.firstPid, finalPid: result.value.outputs.finalPid }
									: { error: String((result.value as { error?: unknown }).error) }),
							},
				);
			return {};
		},
	});
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: WORKERS,
		leaseMs: WORK_LEASE_MS,
		definitions: [{ definition: child, path: childPath, exportName }],
		coordinator: "in-process",
	});
	// Every few writes of each kind, the journal refuses the next ones several times in a row before it takes one.
	const refusing = (kind: "enqueue" | "commit" | "claim" | "complete") => {
		const original = SqlPoolQueue.prototype[kind] as (...args: unknown[]) => Promise<unknown>;
		let calls = 0;
		let owed = 0;
		vi.spyOn(SqlPoolQueue.prototype, kind).mockImplementation(async function (
			this: SqlPoolQueue,
			...args: unknown[]
		) {
			if (owed > 0) {
				owed--;
				throw refused();
			}
			if (++calls % 4 === 1) {
				owed = REFUSALS_IN_A_ROW - 1;
				throw refused();
			}
			return original.apply(this, args);
		} as never);
	};
	void refusing;
	fault();
	const runId = randomUUID();
	const budget = AbortSignal.timeout(BUDGET.waitMs);
	try {
		const running = run(
			parent,
			{},
			{ runId, cwd: directory, store: createStore(), durableBackend: backend, signal: budget },
		);
		let ended: unknown;
		void running.then(
			(value) => {
				ended = value;
			},
			(error: unknown) => {
				ended = error;
			},
		);
		await waitUntil(
			() => {
				if (ended !== undefined)
					assert.fail(
						`the root ended before every child started: ${JSON.stringify(ended)} ${JSON.stringify(children)}`,
					);
				// One file per attempt that started its child: count the children, not the attempts.
				return (
					new Set(
						readDirectorySync(directory)
							.filter((name) => name.startsWith("started-"))
							.map((name) => name.split("-")[1]),
					).size === CHILDREN
				);
			},
			"every child to start",
			budget,
		);
		await sleep(1_000);
		await writeFileEnsuringDir(join(directory, "release"), "");
		const result = await running;
		assert.equal(result.status, "completed", JSON.stringify(result));
		assert.equal(children.length, CHILDREN);
		for (const outcome of children) {
			assert.equal(outcome.status, "completed", JSON.stringify(children));
			// The attempt that started the child finished it: no refusal ended it or replayed the child elsewhere.
			if (!handedOn) assert.equal(outcome.finalPid, outcome.firstPid, JSON.stringify(children));
		}
		vi.restoreAllMocks();
		// Each child's work was claimed once: no refused write spent an attempt.
		const items = await (await openSqlPoolQueue(journal)).inspect(runId);
		assert.deepEqual(
			items.map((item) => [item.state, item.generation - (item.handoffs ?? 0)]),
			Array.from({ length: CHILDREN }, () => ["completed", 1]),
		);
	} finally {
		vi.restoreAllMocks();
		await pool.close().catch(() => {});
		await backend.close();
		await journal.close();
		await database.close();
		removeTempDirectory(directory);
	}
}

/** Every few writes of `kind`, the journal refuses the next ones several times in a row before it takes one. */
function refusing(kind: "enqueue" | "commit" | "claim" | "complete") {
	const original = SqlPoolQueue.prototype[kind] as (...args: unknown[]) => Promise<unknown>;
	let calls = 0;
	let owed = 0;
	vi.spyOn(SqlPoolQueue.prototype, kind).mockImplementation(async function (this: SqlPoolQueue, ...args: unknown[]) {
		if (owed > 0) {
			owed--;
			throw refused();
		}
		if (++calls % 4 === 1) {
			owed = REFUSALS_IN_A_ROW - 1;
			throw refused();
		}
		return original.apply(this, args);
	} as never);
}

test.skipIf(process.platform === "win32")(
	"pooled children whose enqueues, checkpoint commits, claims and completions the journal refuses for a while complete without losing an attempt (#4768)",
	() =>
		runChildrenWhile(() => {
			for (const kind of ["enqueue", "commit", "claim", "complete"] as const) refusing(kind);
		}),
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a child whose first host's commit the store can never take is handed to another attempt without spending one, and completes (#4768)",
	() =>
		runChildrenWhile(() => {
			// The store refuses each child's first commit outright, as sqld refuses a response past its size limit for a
			// host that has not read the root yet: that host can never commit it, so its attempt hands the child on.
			const original = SqlPoolQueue.prototype.commit;
			const refusedOnce = new Set<string>();
			vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async function (
				this: SqlPoolQueue,
				...args: Parameters<SqlPoolQueue["commit"]>
			) {
				const work = args[1].id;
				if (!refusedOnce.has(work)) {
					refusedOnce.add(work);
					throw new StorageUnavailableError(
						{ adapter: "libsql", location: "http://127.0.0.1:1" },
						Object.assign(new Error("RESPONSE_TOO_LARGE: Response is too large"), { code: "RESPONSE_TOO_LARGE" }),
					);
				}
				return original.apply(this, args);
			});
		}, true),
	BUDGET.timeoutMs,
);
