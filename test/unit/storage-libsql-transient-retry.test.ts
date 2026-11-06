import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { StorageTransientError } from "../../packages/coding-agent/src/core/storage/index.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { type Lease, RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import {
	countRows,
	type FakeLibsqlServer,
	failFirstFetch,
	networkFailure,
	stallNextTransaction,
	startFakeLibsqlServer,
	timeOutNextTransaction,
	useFakeLibsqlServers,
} from "../helpers/fake-libsql-server.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();
const { server, open } = useFakeLibsqlServers();

/** Collects the warnings the process emits while `action` runs. */
async function warningsDuring(action: () => Promise<void>): Promise<Error[]> {
	const warnings: Error[] = [];
	const onWarning = (warning: Error) => warnings.push(warning);
	process.on("warning", onWarning);
	try {
		await action();
		// A warning is emitted on the next tick.
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.off("warning", onWarning);
	}
	return warnings;
}

test("a transaction whose stream the server expired runs again and commits once (#4383)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	stallNextTransaction(fake);
	let runs = 0;
	await database.transaction(
		async (tx) => {
			runs++;
			await tx.run("INSERT INTO events VALUES (1)");
			await tx.run("INSERT INTO events VALUES (2)");
		},
		{ retryTransientFailures: true },
	);
	assert.equal(runs, 2);
	assert.equal(fake.expiredStatements, 1);
	assert.deepEqual(
		fake.database
			.prepare("SELECT n FROM events ORDER BY n")
			.all()
			.map((row) => Number(row.n)),
		[1, 2],
	);
});

test("a commit that found its stream expired runs the transaction again: the commit never applied (#4383)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	stallNextTransaction(fake);
	let runs = 0;
	await database.transaction(
		async (tx) => {
			runs++;
			await tx.run("INSERT INTO events VALUES (1)");
		},
		{ retryTransientFailures: true },
	);
	assert.equal(runs, 2);
	assert.equal(fake.expiredStatements, 1, "the commit found the stream expired");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

test("a transaction the server timed out runs again and commits once (#4383)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	timeOutNextTransaction(fake);
	const seen: unknown[] = [];
	let runs = 0;
	await database.transaction(
		async (tx) => {
			runs++;
			await tx.run("INSERT INTO events VALUES (1)");
			await tx.run("INSERT INTO events VALUES (2)").catch((error: unknown) => {
				seen.push(error);
				throw error;
			});
		},
		{ retryTransientFailures: true },
	);
	assert.equal(runs, 2);
	assert.ok(seen[0] instanceof StorageTransientError);
	assert.deepEqual([seen[0].code, seen[0].outcome], ["transaction-timeout", "not-applied"]);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

test("a database opened while its server is still starting connects on a later run (#4383)", async () => {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as { port: number };
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	let started: Promise<FakeLibsqlServer> | undefined;
	const onWarning = () => {
		started ??= startFakeLibsqlServer({ port });
	};
	process.on("warning", onWarning);
	const warnings = await warningsDuring(async () => {
		try {
			const database = await open(`http://127.0.0.1:${port}`);
			assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
		} finally {
			process.off("warning", onWarning);
			await (await started)?.close();
		}
	});
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0] instanceof StorageTransientError);
	assert.deepEqual([warnings[0].code, warnings[0].outcome], ["connection-refused", "not-applied"]);
});

test("network codes for a request that never reached the server run it again (#4383)", async () => {
	const fake = await server();
	for (const [code, depth] of [
		["ECONNREFUSED", 0],
		["ECONNREFUSED", 1],
		["EAI_AGAIN", 1],
		["UND_ERR_CONNECT_TIMEOUT", 1],
		["ECONNREFUSED", 7],
	] as const) {
		failFirstFetch(networkFailure(code, depth));
		const warnings = await warningsDuring(async () => {
			const database = await open(fake.url);
			assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 }, `${code} at depth ${depth}`);
		});
		assert.equal(warnings.length, 1, `${code} at depth ${depth}`);
		assert.equal((warnings[0] as StorageTransientError).code, "connection-refused");
	}
});

const header = { runId: "root", name: "root", cwd: "/work", createdAt: 0, status: "running" };
const checkpoint = (stage: string): RunEvent =>
	({ type: RUN_EVENT_TYPES.checkpointRecorded, payload: { kind: "stage", stage, status: "completed" } }) as RunEvent;
const statusChanged = (status: string): RunEvent =>
	({ type: RUN_EVENT_TYPES.statusChanged, payload: { status } }) as RunEvent;

async function journalOn(fake: FakeLibsqlServer): Promise<{ journal: SqlRunJournal; lease: Lease }> {
	const database = await open(fake.url);
	await database.exec("CREATE TABLE scratch(n INTEGER NOT NULL)");
	const journal = await SqlRunJournal.open(database);
	await journal.createRun(header);
	const acquired = await journal.acquire("root", "holder");
	if (acquired.status !== "acquired") assert.fail("lease not acquired");
	return { journal, lease: acquired.lease };
}

async function entries(journal: SqlRunJournal) {
	const read = [];
	for await (const entry of journal.read("root")) read.push(entry);
	return read;
}

test("journal appends whose stream expired mid-transaction are written exactly once (#4383)", async () => {
	const fake = await server();
	const { journal, lease } = await journalOn(fake);
	stallNextTransaction(fake);
	const keyed = await journal.append(lease, checkpoint("plan"), { key: "stage:plan" });
	stallNextTransaction(fake);
	const keyless = await journal.append(lease, statusChanged("waiting"));
	assert.equal(keyed.status, "appended");
	assert.equal(keyless.status, "appended");
	assert.equal(fake.expiredStatements, 2);
	assert.deepEqual(
		(await entries(journal)).map((entry) => [entry.seq, entry.key ?? null, entry.event.type]),
		[
			[1, "stage:plan", "CheckpointRecorded"],
			[2, null, "StatusChanged"],
		],
	);
	assert.equal((await journal.getRun("root"))?.status, "waiting");
});

test("a batch of journal appends whose connection broke is never sent twice (#4383)", async () => {
	const fake = await server();
	const { journal, lease } = await journalOn(fake);
	const appends = [
		{ event: checkpoint("a"), key: "stage:a", context: <T>(action: () => T) => action() },
		{ event: statusChanged("waiting"), context: <T>(action: () => T) => action() },
	];
	fake.fail({ kind: "reset-after" });
	await assert.rejects(journal.appendMany(lease, appends), (error: unknown) => {
		assert.ok(error instanceof StorageTransientError);
		assert.equal(error.outcome, "unknown");
		return true;
	});
	assert.deepEqual(
		(await entries(journal)).map((entry) => [entry.seq, entry.key ?? null]),
		[
			[1, "stage:a"],
			[2, null],
		],
	);
});

test("a pool table transaction on the journal fails typed instead of running its callback again (#4383)", async () => {
	const fake = await server();
	const { journal } = await journalOn(fake);
	const storage = sqlPoolStorage(journal);
	assert.ok(storage);
	stallNextTransaction(fake);
	let runs = 0;
	await assert.rejects(
		storage.transaction(async (tx) => {
			runs++;
			await tx.run("INSERT INTO scratch VALUES (1)");
			await tx.run("INSERT INTO scratch VALUES (2)");
		}),
		(error: unknown) => {
			assert.ok(error instanceof StorageTransientError);
			assert.deepEqual([error.code, error.outcome, error.attempts], ["stream-expired", "not-applied", 1]);
			return true;
		},
	);
	assert.equal(runs, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM scratch"), 0);
	await storage.transaction((tx) => tx.run("INSERT INTO scratch VALUES (3)"));
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM scratch"), 1);
});

test("session writes whose stream expired mid-transaction are written exactly once (#4383)", async () => {
	const fake = await server();
	const store = await SqlSessionStore.open(await open(fake.url));
	const sessionHeader = {
		id: "session-1",
		version: SESSION_FORMAT_VERSION,
		cwd: "/work",
		createdAt: "2026-01-01T00:00:00Z",
	} as const;
	const message = (id: string): SessionEntry => ({
		type: "message",
		id,
		parentId: null,
		timestamp: sessionHeader.createdAt,
		message: { role: "user", content: id, timestamp: Date.parse(sessionHeader.createdAt) },
	});
	try {
		await store.create(sessionHeader, [message("one")]);
		stallNextTransaction(fake);
		assert.deepEqual(await store.append("session-1", [message("two")], { expectSeq: 1 }), { lastSeq: 2 });
		assert.equal(fake.expiredStatements, 1);
		const loaded = await store.load("session-1");
		assert.deepEqual(
			loaded.entries.map((each) => each.id),
			["one", "two"],
		);
		assert.equal(loaded.lastSeq, 2);
	} finally {
		await store.close();
	}
});
