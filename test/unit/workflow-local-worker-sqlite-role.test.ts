import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
	declareSqliteProcessRole,
	openNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { POOL_COORDINATOR_ROLE } from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { runLocalWorker } from "../../packages/workflows/src/workers/local-worker.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

/**
 * Which thread a process's SQLite statements run on follows what the process is (#5376): an interactive process, the
 * default, gives each file-backed connection a thread of its own; a pool's coordinator and workers, which have no UI,
 * run them on the calling thread, as their many small journal writes cannot afford a round trip each.
 */

// The coordinator's own loop needs the IPC channel of a forked process; this test checks only what starting it sets.
vi.mock("../../packages/workflows/src/workers/pool-coordinator.js", () => ({ runPoolCoordinator: () => undefined }));

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	declareSqliteProcessRole("interactive");
});

/** How many requests a file-backed connection opened now sends to a connection thread to open, write and read. */
async function threadRequests(): Promise<number> {
	const directory = makeTempDirectory("sqlite-process-role-");
	cleanups.push(() => removeTempDirectory(directory));
	let sent = 0;
	const interception = interceptConnectionRequests((request, send) => {
		sent++;
		return send(request);
	});
	try {
		const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
		try {
			await database.transaction((transaction) => transaction.run("CREATE TABLE t(v)"));
			await database.run("INSERT INTO t VALUES (1)");
			assert.deepEqual(await database.all("SELECT v FROM t"), [{ v: 1 }]);
		} finally {
			await database.close();
		}
	} finally {
		interception.restore();
	}
	return sent;
}

test("an interactive process opens each file-backed connection on a thread of its own, whatever it loaded (#5376)", async () => {
	// This process loaded the local worker's module, as an interactive host that runs workflows does.
	assert.ok((await threadRequests()) > 0, "the connection's statements went to its thread");
});

test("a pool's coordinator runs its connections' statements on the calling thread (#5376)", async () => {
	await runLocalWorker({ role: POOL_COORDINATOR_ROLE });
	assert.equal(await threadRequests(), 0, "no statement went to a connection thread");
});
