import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { testRunId } from "../helpers/run-id.js";
import {
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

/** Short, so a waiter that treats the stall as an idle lock fails within the test. */
const LOCK_WAIT_MS = 500;
/** How long the holder stays stalled mid-transaction: many lock waits. */
const STALL_MS = 3_000;
const TEST_TIMEOUT_MS = 90_000;
const HOLDER = fileURLToPath(new URL("../fixtures/sqlite-stalling-holder.mjs", import.meta.url));

type Stall = "stopped" | "event loop blocked";

async function readLine(child: SpawnedProcess): Promise<string> {
	assert.ok(child.stdout);
	const reader = child.stdout.getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(`holder exited: ${await readStreamText(child.stderr)}`);
			text += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return text.trim();
}

/**
 * Another Atomic process takes the write lock mid-transaction and stalls holding it: stopped by a signal, or with its
 * own event loop blocked. Resolves once the lock is held; `release` lets the holder commit and waits for it to exit.
 */
async function stallingHolder(path: string, stall: Stall) {
	const holder = spawnProcess([process.execPath, HOLDER, path, stall === "stopped" ? "stdin" : `spin:${STALL_MS}`], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(await readLine(holder), "locked");
	if (stall === "stopped") holder.kill("SIGSTOP");
	return {
		pid: holder.pid,
		async release() {
			if (stall === "stopped") {
				holder.kill("SIGCONT");
				holder.stdin?.end("commit\n");
			}
			assert.equal(await readLine(holder), "committed");
			assert.equal(await holder.exited, 0, await readStreamText(holder.stderr));
		},
		async kill() {
			holder.kill("SIGKILL");
			await holder.exited;
		},
	};
}

/** Largest gap between ticks of a 20 ms timer until stopped, including the one still open. */
function watchEventLoop() {
	let last = performance.now();
	let maxGapMs = 0;
	const ticker = setInterval(() => {
		const now = performance.now();
		maxGapMs = Math.max(maxGapMs, now - last);
		last = now;
	}, 20);
	return () => {
		clearInterval(ticker);
		return Math.max(maxGapMs, performance.now() - last);
	};
}

for (const stall of ["stopped", "event loop blocked"] as const)
	test.skipIf(process.platform === "win32")(
		`journal writes wait out another process holding the write lock while ${stall}, and none fails`,
		async () => {
			const directory = makeTempDirectory("journal-stalled-holder-");
			const path = join(directory, "journal.sqlite");
			const database = await openNodeSqliteDatabase(path, { lockWaitMs: LOCK_WAIT_MS });
			const journal = await SqlRunJournal.open(database);
			let holder: Awaited<ReturnType<typeof stallingHolder>> | undefined;
			try {
				await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
				const acquired = await journal.acquire("root", "coordinator");
				if (acquired.status !== "acquired") assert.fail("lease not acquired");
				const lease = acquired.lease;
				const pool = await openSqlPoolQueue(journal);
				await pool.initialize(lease, 600_000);
				const { work, boundary } = poolWorkFixture();
				await pool.enqueue(lease, work, boundary);

				holder = await stallingHolder(path, stall);
				const stopWatching = watchEventLoop();
				let settledDuringStall = 0;
				const writes = [
					journal.createRun({ runId: "child", name: "child", cwd: "", createdAt: 0, status: "running" }),
					journal.append(lease, { type: RUN_EVENT_TYPES.statusChanged, payload: { status: "running" } } as never),
					journal.renew(lease),
					pool.claim(lease, "worker", [{ definition: work.definition, digest: work.digest }], 600_000),
				];
				const settled = Promise.allSettled(writes);
				for (const write of writes)
					void write.then(
						() => settledDuringStall++,
						() => settledDuringStall++,
					);
				await sleep(STALL_MS);
				const maxGapMs = stopWatching();
				// A stopped holder still holds the lock: nothing can have committed, or failed, yet.
				if (stall === "stopped")
					assert.equal(settledDuringStall, 0, "a write settled while the holder was stopped");
				await holder.release();
				const outcomes = await settled;
				assert.deepEqual(
					outcomes.map((outcome) => (outcome.status === "rejected" ? String(outcome.reason) : "fulfilled")),
					["fulfilled", "fulfilled", "fulfilled", "fulfilled"],
				);
				if (stall === "stopped")
					assert.ok(
						maxGapMs < 1_000,
						`the event loop stalled for ${Math.round(maxGapMs)} ms waiting for the lock`,
					);
				assert.equal((await journal.getRun("child"))?.name, "child");
			} finally {
				await holder?.kill();
				await journal.close();
				await database.close();
				removeTempDirectory(directory);
			}
		},
		TEST_TIMEOUT_MS,
	);

test.skipIf(process.platform === "win32")(
	"a workflow run keeps going while another process holding the journal's write lock is stopped",
	async () => {
		const directory = makeTempDirectory("journal-stalled-holder-run-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path, { lockWaitMs: LOCK_WAIT_MS });
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		let holder: Awaited<ReturnType<typeof stallingHolder>> | undefined;
		try {
			const child = workflow({
				name: "stalled-holder-child",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.tool("child-step", {}, async () => 1);
					return {};
				},
			});
			let stepsBeforeStall = 0;
			const stalled = Promise.withResolvers<void>();
			const root = workflow({
				name: "stalled-holder-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.tool("before", {}, async () => ++stepsBeforeStall);
					// The next durable steps are written while the other process holds the lock, stopped.
					await stalled.promise;
					await Promise.all([ctx.tool("during", {}, async () => 2), ctx.workflow(child), ctx.workflow(child)]);
					await ctx.tool("after", {}, async () => 3);
					return {};
				},
			});
			const store = createStore();
			const execution = run(
				root,
				{},
				{ runId: testRunId("stalled-holder"), cwd: directory, store, durableBackend: backend },
			);
			while (stepsBeforeStall === 0) await sleep(10);
			holder = await stallingHolder(path, "stopped");
			stalled.resolve();
			await sleep(STALL_MS);
			await holder.release();
			const result = await execution;
			assert.equal(result.status, "completed", result.error);
		} finally {
			await holder?.kill();
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a writer that gives up on a write lock held by a stopped process names that process",
	async () => {
		const directory = makeTempDirectory("journal-stalled-holder-named-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 0, lockWaitMs: LOCK_WAIT_MS });
		let holder: Awaited<ReturnType<typeof stallingHolder>> | undefined;
		try {
			await database.exec("CREATE TABLE probe(x)");
			holder = await stallingHolder(path, "stopped");
			const error = await database
				.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"))
				.then(
					() => assert.fail("write succeeded under a held lock"),
					(cause: unknown) => cause,
				);
			assert.ok(error instanceof StorageUnavailableError, String(error));
			assert.match(
				error.message,
				new RegExp(
					`gave up after \\d+ ms waiting for the write lock.*held all that time by process ${holder.pid}\\b`,
				),
			);
			await holder.release();
		} finally {
			await holder?.kill();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	TEST_TIMEOUT_MS,
);

const STALLED_WRITER = fileURLToPath(new URL("../fixtures/sqlite-stalled-writer.mjs", import.meta.url));
const SLOW_MEMBERS = 40;
const SLOW_MEMBER_MS = 25;

test.skipIf(process.platform === "win32")(
	"a long group commit lets another process's writer in instead of holding the write lock for the whole batch",
	async () => {
		const directory = makeTempDirectory("journal-group-commit-hold-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		let writer: SpawnedProcess | undefined;
		try {
			// The other writer's row records how many of this connection's rows had committed when it got the lock.
			await database.exec(`
				CREATE TABLE slow(n INTEGER);
				CREATE TABLE probe(x INTEGER);
				CREATE TRIGGER probe_counts AFTER INSERT ON probe BEGIN
					UPDATE probe SET x = (SELECT COUNT(*) FROM slow) WHERE rowid = NEW.rowid;
				END;
			`);
			writer = spawnProcess([process.execPath, STALLED_WRITER, path, "60000"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			assert.equal(await readLine(writer), "ready");
			const entered = Promise.withResolvers<void>();
			// Queued together, so they share one group commit; each is CPU work while the lock is held.
			const members = Array.from({ length: SLOW_MEMBERS }, (_, index) =>
				database.transaction(async (tx) => {
					entered.resolve();
					const until = performance.now() + SLOW_MEMBER_MS;
					while (performance.now() < until) {
						// Busy, as a process starved of CPU is.
					}
					await tx.run("INSERT INTO slow VALUES (?)", index);
				}),
			);
			await entered.promise;
			writer.stdin?.end("go\n");
			await Promise.all(members);
			const outcome = JSON.parse(await readLine(writer)) as { error: { message: string } | null };
			assert.equal(outcome.error, null, JSON.stringify(outcome));
			const seen = (await database.get<{ x: number }>("SELECT x FROM probe"))!.x;
			assert.ok(
				seen < SLOW_MEMBERS * 0.75,
				`the other writer waited until ${seen} of ${SLOW_MEMBERS} transactions (${SLOW_MEMBERS * SLOW_MEMBER_MS} ms of work) had committed`,
			);
		} finally {
			writer?.kill("SIGKILL");
			await writer?.exited;
			await database.close();
			removeTempDirectory(directory);
		}
	},
	TEST_TIMEOUT_MS,
);

test("a connection's write-lock record goes away when it closes, and records of exited processes are removed", async () => {
	const directory = makeTempDirectory("journal-holder-records-");
	const path = join(directory, "journal.sqlite");
	const holders = `${path}-holders`;
	// A process that was killed while it held the lock left its record behind; pids this large are never live.
	mkdirSync(holders, { recursive: true });
	writeFileSync(join(holders, "999999999-1"), `held ${String(Date.now()).padStart(15, "0")}\n`);
	const database = await openNodeSqliteDatabase(path);
	try {
		await database.transaction((tx) => tx.exec("CREATE TABLE probe(x)"));
		assert.deepEqual(
			readdirSync(holders).map((name) => name.split("-")[0]),
			[String(process.pid)],
		);
		await database.close();
		assert.deepEqual(readdirSync(holders), []);
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});
