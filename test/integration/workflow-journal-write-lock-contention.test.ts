import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import {
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "../helpers/runtime.js";

const LOCK_CONTENTION_TEST_TIMEOUT_MS = 60_000;

/** Another process takes the journal's write lock, reports `locked`, and commits after `holdMs` (never when negative). */
const LOCK_HOLDER = `
const { DatabaseSync } = require("node:sqlite");
const [path, holdMs] = process.argv.slice(1);
const database = new DatabaseSync(path);
database.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS lock_holder(x); INSERT INTO lock_holder VALUES (1)");
process.stdout.write("locked\\n");
if (Number(holdMs) >= 0) setTimeout(() => { database.exec("COMMIT"); database.close(); }, Number(holdMs));
else setInterval(() => {}, 1_000);
`;

async function holdWriteLock(path: string, holdMs: number): Promise<SpawnedProcess> {
	const holder = spawnProcess([process.execPath, "-e", LOCK_HOLDER, path, String(holdMs)], {
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.ok(holder.stdout);
	const reader = holder.stdout.getReader();
	let text = "";
	try {
		while (!text.includes("\n")) {
			const next = await reader.read();
			if (next.done) assert.fail(await readStreamText(holder.stderr));
			text += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	assert.equal(text, "locked\n");
	return holder;
}

/**
 * A starting pooled stage's Intercom extension writes its pending-stage delivery and prelude message through journal
 * transactions. In the 480-child soak another process held the journal's write lock past the 5 s busy timeout, and
 * the stage failed `Extension startup failed: …intercom…: Storage unavailable: node-sqlite at …journal5.sqlite`.
 */
test(
	"a journal write waits out another process's write lock held past the busy timeout",
	async () => {
		const directory = makeTempDirectory("journal-lock-contention-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		let holder: SpawnedProcess | undefined;
		try {
			await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "coordinator");
			if (acquired.status !== "acquired") assert.fail("lease not acquired");
			const pool = await openSqlPoolQueue(journal);
			await pool.initialize(acquired.lease, 600_000);
			const { work, boundary } = poolWorkFixture();
			await pool.enqueue(acquired.lease, work, boundary);
			const claimed = await pool.claim(
				acquired.lease,
				"worker",
				[{ definition: work.definition, digest: work.digest }],
				600_000,
			);
			assert.ok(claimed);
			holder = await holdWriteLock(path, 6_500);
			await pool.assertCurrent(acquired.lease, claimed);
			assert.equal(await holder.exited, 0, await readStreamText(holder.stderr));
		} finally {
			holder?.kill("SIGKILL");
			await holder?.exited;
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	LOCK_CONTENTION_TEST_TIMEOUT_MS,
);

test(
	"a write lock that is never released fails within the bound and names the SQLite cause",
	async () => {
		const directory = makeTempDirectory("journal-lock-unavailable-");
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 100, lockWaitMs: 500 });
		let holder: SpawnedProcess | undefined;
		try {
			await database.exec("CREATE TABLE probe(x)");
			holder = await holdWriteLock(path, -1);
			const started = Date.now();
			const error = await database
				.transaction((tx) => tx.run("INSERT INTO probe VALUES (1)"))
				.then(
					() => assert.fail("write succeeded under a held lock"),
					(cause: unknown) => cause,
				);
			assert.ok(error instanceof StorageUnavailableError);
			assert.match(error.message, /^Storage unavailable: node-sqlite at .*journal\.sqlite: database is locked/);
			assert.match((error.cause as Error).message, /database is locked/);
			assert.ok(Date.now() - started < 5_000, `gave up after ${Date.now() - started} ms`);
		} finally {
			holder?.kill("SIGKILL");
			await holder?.exited;
			await database.close();
			removeTempDirectory(directory);
		}
	},
	LOCK_CONTENTION_TEST_TIMEOUT_MS,
);
