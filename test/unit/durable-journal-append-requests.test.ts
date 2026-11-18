import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { type Lease, StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

/**
 * A run journal's append on a node-sqlite connection crosses to the connection's thread once (#5376): the lease, key
 * and sequence checks and the insert run there in one transaction, with the write lock and the commit, rather than as
 * seven requests whose round trips each wait for both threads to be scheduled.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function journalWithLease() {
	const directory = makeTempDirectory("journal-append-requests-");
	cleanups.push(() => removeTempDirectory(directory));
	const journal = await openSqlRunJournal(join(directory, "journal.sqlite"));
	cleanups.push(() => journal.close());
	await journal.createRun({ runId: "run", name: "run", cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("run", "owner");
	if (acquired.status !== "acquired") return assert.fail("the run's lease was not acquired");
	return { journal, lease: acquired.lease };
}

/** The run's events, in order, as their sequence and type. */
async function events(journal: Awaited<ReturnType<typeof openSqlRunJournal>>): Promise<[number, string][]> {
	const read: [number, string][] = [];
	for await (const entry of journal.read("run")) read.push([entry.seq, entry.event.type]);
	return read;
}

/** The requests the journal's connection sends its thread while `work` runs. */
async function requests<T>(work: () => Promise<T>): Promise<{ value: T; sent: ConnectionRequest[] }> {
	const sent: ConnectionRequest[] = [];
	const interception = interceptConnectionRequests((request, send) => {
		sent.push(request);
		return send(request);
	});
	try {
		return { value: await work(), sent };
	} finally {
		interception.restore();
	}
}

test("an append is one request to its connection's thread, lock and commit included (#5376)", async () => {
	const { journal, lease } = await journalWithLease();
	const { value, sent } = await requests(() =>
		journal.append(lease, { type: "StatusChanged", payload: { status: "paused" } }, { key: "status-1" }),
	);
	assert.deepEqual(
		sent.map((request) => request.kind),
		["transaction"],
	);
	assert.equal(value.status, "appended");
	assert.deepEqual(await events(journal), [[1, "StatusChanged"]]);
});

test("an append whose lease another holder took writes nothing and rejects, in its one request (#5376)", async () => {
	const { journal, lease } = await journalWithLease();
	await journal.release(lease);
	const taken = await journal.acquire("run", "other-owner");
	assert.equal(taken.status, "acquired");
	const stale: Lease = { ...lease };
	const { value, sent } = await requests(() =>
		journal.append(stale, { type: "StatusChanged", payload: { status: "failed" } }).then(
			() => assert.fail("the stale append was written"),
			(error: unknown) => error,
		),
	);
	assert.ok(value instanceof StaleLeaseError, String(value));
	assert.deepEqual(
		sent.map((request) => request.kind),
		["transaction"],
	);
	assert.deepEqual(await events(journal), [], "nothing of the stale append was written");
});
