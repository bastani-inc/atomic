import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

/** A child of the pool: its module, its export, and its inputs given the test's directory. */
interface ChildFixture {
	readonly path: string;
	readonly exportName: string;
	readonly inputs: (directory: string) => Record<string, string | number>;
}

/** Holds its step until the test writes `release`, after writing `started-<index>-<pid>`. */
const RESUMED_CHILD: ChildFixture = {
	path: fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url)),
	exportName: "resumedChild",
	inputs: (directory) => ({ directory, index: 0 }),
};

/** Its first attempt's request to complete fails to send; its replay completes. */
const FAILING_COMPLETION_CHILD: ChildFixture = {
	path: fileURLToPath(new URL("../fixtures/pool-failing-completion-child.ts", import.meta.url)),
	exportName: "failingCompletionChild",
	inputs: (directory) => ({ directory }),
};
/** Two pool cold starts at most: the first worker and, in the first test, its replacement. */
const BUDGET = poolTestBudgetMs(2);
/**
 * How long a worker whose channel closed may take to exit. Far below the heartbeat interval of these pools, so a worker
 * that only noticed the closed channel at its next heartbeat would miss it.
 */
const CHANNEL_EXIT_BOUND_MS = 10_000;

interface WorkerMessage {
	readonly pid: number | undefined;
	readonly kind: string | undefined;
}

/**
 * The pool's workers as their in-process coordinator sees them: each forked worker, what it sent the coordinator, and
 * how it exited.
 */
function observeWorkers() {
	const spawned: ChildProcess[] = [];
	const messages: WorkerMessage[] = [];
	const exits: { readonly pid: number | undefined; readonly code: number | null }[] = [];
	const emit = ChildProcess.prototype.emit as (
		this: ChildProcess,
		event: string | symbol,
		...args: unknown[]
	) => boolean;
	vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
		this: ChildProcess,
		event: string | symbol,
		...args: unknown[]
	) {
		if (event === "spawn") spawned.push(this);
		if (event === "message") messages.push({ pid: this.pid, kind: (args[0] as { readonly kind?: string }).kind });
		if (event === "exit") exits.push({ pid: this.pid, code: args[0] as number | null });
		return emit.call(this, event, ...args);
	});
	return { spawned, messages, exits };
}

async function waitUntil(predicate: () => boolean, what: string, signal: AbortSignal): Promise<void> {
	while (!predicate()) {
		if (signal.aborted) throw new Error(`Timed out waiting for ${what}`);
		await sleep(20);
	}
}

function started(directory: string): number {
	return readdirSync(directory).filter((name) => name.startsWith("started-")).length;
}

async function poolFixture(
	timing: { readonly leaseMs: number; readonly heartbeatMs?: number },
	fixture: ChildFixture = RESUMED_CHILD,
) {
	const directory = makeTempDirectory("pool-worker-channel-");
	const path = join(directory, "journal.sqlite");
	const { path: childPath, exportName } = fixture;
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName }],
		coordinator: "in-process",
		...timing,
	});
	const parent = workflow({
		name: "pool-worker-channel-root",
		description: "Root over one pooled child",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const result = await ctx.workflow(child, { inputs: fixture.inputs(directory) });
			assert.equal(result.status, "completed");
			return {};
		},
	});
	const runId = randomUUID();
	const stop = new AbortController();
	const budget = AbortSignal.timeout(BUDGET.waitMs);
	return {
		directory,
		journal,
		backend,
		pool,
		runId,
		budget,
		start: () =>
			run(
				parent,
				{},
				{
					runId,
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.any([budget, stop.signal]),
				},
			),
		async close() {
			if (stop.signal.aborted) return;
			stop.abort();
			vi.restoreAllMocks();
			await pool.close().catch(() => {});
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test.skipIf(process.platform === "win32")(
	"a worker whose channel to its pool closes exits at once as a crash, and its child replays on a replacement (#4327)",
	async () => {
		// A long lease, so the worker's next heartbeat, which would also find the channel closed, is far away.
		const f = await poolFixture({ leaseMs: 240_000 });
		const workers = observeWorkers();
		try {
			const running = f.start();
			await waitUntil(() => started(f.directory) === 1, "the child to start", f.budget);
			const [worker] = workers.spawned;
			assert.ok(worker?.pid !== undefined, "the pool forked its worker");
			worker.disconnect();
			await waitUntil(
				() => workers.exits.some((exit) => exit.pid === worker.pid),
				"the disconnected worker to exit",
				AbortSignal.timeout(CHANNEL_EXIT_BOUND_MS),
			);
			assert.equal(
				workers.exits.find((exit) => exit.pid === worker.pid)?.code,
				1,
				"a channel that closes under a worker is no clean end",
			);
			await writeFileEnsuringDir(join(f.directory, "release"), "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.equal(workers.spawned.length, 2, "a replacement ran the replay");
		} finally {
			await f.close();
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a worker whose attempt meets the root's lost lease ends cleanly without asking the pool for more (#4327)",
	async () => {
		// A heartbeat every half second meets the lost lease at once; the work lease outlasts the whole test.
		const f = await poolFixture({ leaseMs: 60_000, heartbeatMs: 500 });
		const workers = observeWorkers();
		try {
			const running = f.start().catch((error: unknown) => error);
			await waitUntil(() => started(f.directory) === 1, "the child to start", f.budget);
			const [worker] = workers.spawned;
			assert.ok(worker?.pid !== undefined, "the pool forked its worker");
			const lease = await f.journal.leaseState(f.runId);
			assert.ok(lease?.holderId, "the root holds its lease");
			const taken = await f.journal.takeover(f.runId, "another-root-process", lease.holderId);
			assert.equal(taken.status, "acquired");
			const sentBefore = workers.messages.length;
			// The child's step ends, so its attempt ends too, on the refusal its next request meets.
			await writeFileEnsuringDir(join(f.directory, "release"), "");
			await waitUntil(
				() => workers.exits.some((exit) => exit.pid === worker.pid),
				"the worker to end on the lost root lease",
				f.budget,
			);
			assert.equal(workers.exits.find((exit) => exit.pid === worker.pid)?.code, 0, "the worker ended cleanly");
			const asked = workers.messages
				.slice(sentBefore)
				.filter(
					(message) => message.pid === worker.pid && (message.kind === "claim" || message.kind === "control"),
				);
			assert.deepEqual(asked, [], "a worker whose root is gone asks for no more work or control");
			await f.close();
			await running;
		} finally {
			await f.close();
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a worker whose request to the pool fails crashes at once instead of asking for more work, and its child replays (#4327)",
	async () => {
		// A long lease: a worker that kept its failed attempt instead of crashing would hold it far beyond the test.
		const f = await poolFixture({ leaseMs: 240_000 }, FAILING_COMPLETION_CHILD);
		const workers = observeWorkers();
		try {
			const result = await f.start();
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [first] = workers.spawned;
			assert.ok(first?.pid !== undefined, "the pool forked its worker");
			assert.equal(
				workers.exits.find((exit) => exit.pid === first.pid)?.code,
				1,
				"the worker whose completion could not be sent crashed",
			);
			// An idle worker may claim more than once before the child is enqueued; once its attempt wrote, it claims no more.
			const sent = workers.messages.filter((message) => message.pid === first.pid).map((message) => message.kind);
			const attempt = sent.indexOf("commit");
			assert.ok(attempt >= 0, `its attempt committed the child's step: ${sent.join(", ")}`);
			assert.deepEqual(
				sent.slice(attempt).filter((kind) => kind === "claim"),
				[],
				"it asked for no more work after its failed attempt",
			);
			assert.equal(workers.spawned.length, 2, "a replacement ran the replay");
		} finally {
			await f.close();
		}
	},
	BUDGET.timeoutMs,
);
