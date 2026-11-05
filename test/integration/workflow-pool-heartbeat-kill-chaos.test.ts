/**
 * Chaos for the coalesced worker heartbeat (#4313): a process killed or stopped in the middle of a heartbeat's
 * transaction. The lease renewal, the usage report and the control read share that transaction, so a heartbeat that
 * dies half-way leaves none of them behind, and one stopped while it holds the journal's write lock only delays the
 * heartbeats behind it.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const LEASE_MS = 60_000;
/** How long a heartbeat behind the stopped one is seen to wait for the write lock before the stopped process dies. */
const BLOCKED_OBSERVATION_MS = 1_500;
/** Structural cost: a Bun child process that loads the journal modules from source. */
const HOLDER_PROCESS_TIMEOUT_MS = 90_000;
const holderPath = fileURLToPath(new URL("../fixtures/pool-heartbeat-transaction-holder.ts", import.meta.url));
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const reports = [{ key: "stage:child-boundary:agent", usage: { ...zero, input: 900, output: 300, cost: 3 } }];

async function journalFixture() {
	const directory = makeTempDirectory("pool-heartbeat-kill-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "coordinator");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(lease, 90_000);
	const { work, boundary } = poolWorkFixture();
	await queue.enqueue(lease, work, boundary);
	const attempt = (await queue.claim(lease, "worker", [work], LEASE_MS)) as PoolWork;
	const usage = await openSqlPoolUsage(journal);
	return {
		path,
		lease,
		attempt,
		queue,
		usage,
		async current(): Promise<PoolWork> {
			return (await queue.inspect("root"))[0]!;
		},
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

/** Starts a process that opens a heartbeat transaction and holds it; resolves once it is in the middle of it. */
async function holdHeartbeat(f: Awaited<ReturnType<typeof journalFixture>>): Promise<ChildProcess> {
	const holder = spawn(
		bunExecutable(),
		[holderPath, JSON.stringify({ path: f.path, lease: f.lease, attempt: f.attempt, leaseMs: LEASE_MS, reports })],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	holder.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});
	let stdout = "";
	await new Promise<void>((resolve, reject) => {
		holder.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
			if (stdout.includes("in-transaction")) resolve();
		});
		holder.once("exit", (code, signal) =>
			reject(new Error(`holder exited (${code ?? signal}) before its transaction: ${stderr}`)),
		);
	});
	return holder;
}

async function killed(holder: ChildProcess): Promise<void> {
	const exited = once(holder, "exit");
	holder.kill("SIGKILL");
	await exited;
}

test(
	"a heartbeat killed mid-transaction leaves neither its renewal nor its usage behind (#4313)",
	async () => {
		const f = await journalFixture();
		try {
			const before = await f.current();
			const holder = await holdHeartbeat(f);
			await killed(holder);
			assert.deepEqual(await f.current(), before, "the killed heartbeat renewed nothing");
			assert.deepEqual(await f.usage.total("root"), zero, "and recorded no usage");
			const beat = await f.queue.heartbeat(
				f.lease,
				f.attempt,
				LEASE_MS,
				f.usage.recording(f.lease, f.attempt, reports),
			);
			assert.ok(beat.work.renewedAt >= before.renewedAt, "the next heartbeat renews the attempt");
			assert.deepEqual(beat.recorded, reports[0]!.usage, "and records the usage once");
		} finally {
			await f.close();
		}
	},
	HOLDER_PROCESS_TIMEOUT_MS,
);

test(
	"a heartbeat stopped while it holds the write lock delays the next one, which commits once the lock is free (#4313)",
	async () => {
		const f = await journalFixture();
		try {
			const before = await f.current();
			const holder = await holdHeartbeat(f);
			holder.kill("SIGSTOP");
			let committed = false;
			const waiting = f.queue
				.heartbeat(f.lease, f.attempt, LEASE_MS, f.usage.recording(f.lease, f.attempt, reports))
				.finally(() => {
					committed = true;
				});
			await sleep(BLOCKED_OBSERVATION_MS);
			assert.equal(committed, false, "the next heartbeat waits for the stopped process's write lock");
			await killed(holder);
			const beat = await waiting;
			assert.ok(beat.work.expiresAt >= before.expiresAt, "it renews the attempt once the lock is free");
			assert.deepEqual(await f.usage.total("root"), reports[0]!.usage, "the stopped heartbeat's usage never landed");
			assert.deepEqual(await f.current(), beat.work);
		} finally {
			await f.close();
		}
	},
	HOLDER_PROCESS_TIMEOUT_MS,
);
