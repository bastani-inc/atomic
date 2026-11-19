import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
	StorageRollbackError,
	StorageTransientError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import {
	countRows,
	failFirstFetch,
	networkFailure,
	stallNextTransaction,
	timeOutNextTransaction,
	useFakeLibsqlServers,
} from "../helpers/fake-libsql-server.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();
const { server, open } = useFakeLibsqlServers();

test("a transaction whose stream the server expired fails typed as not applied (#4383)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	stallNextTransaction(fake);
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (1)");
			await tx.run("INSERT INTO events VALUES (2)");
		}),
		(error: unknown) => {
			assert.ok(error instanceof StorageTransientError);
			assert.deepEqual(
				[error.code, error.outcome, error.attempts, error.adapter],
				["stream-expired", "not-applied", 1, "libsql"],
			);
			assert.equal((error.cause as { code?: unknown }).code, "STREAM_EXPIRED");
			return true;
		},
	);
	assert.equal(fake.expiredStatements, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

test("a transaction the server timed out fails typed as not applied, under the failed rollback (#4383)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	timeOutNextTransaction(fake);
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (1)");
			await tx.run("INSERT INTO events VALUES (2)");
		}),
		(error: unknown) => {
			// The server already rolled the transaction back, so the rollback fails; the timeout stays its cause.
			assert.ok(error instanceof StorageRollbackError);
			assert.ok(error.cause instanceof StorageTransientError);
			assert.deepEqual([error.cause.code, error.cause.outcome], ["transaction-timeout", "not-applied"]);
			return true;
		},
	);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

test("a statement whose connection broke is not sent again: its outcome is unknown (#4383)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	for (const kind of ["reset-before", "closed-before"] as const) {
		const before = fake.pipelines.length;
		fake.fail({ kind });
		await assert.rejects(database.run("INSERT INTO events VALUES (1)"), (error: unknown) => {
			assert.ok(error instanceof StorageTransientError, kind);
			assert.deepEqual([error.code, error.outcome, error.attempts], ["connection-lost", "unknown", 1]);
			return true;
		});
		assert.equal(fake.pipelines.length, before + 1, `${kind}: sent once`);
	}
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
	// The connection broke after the server applied the write: one row, never a second.
	fake.fail({ kind: "reset-after" });
	await assert.rejects(database.run("INSERT INTO events VALUES (2)"), StorageTransientError);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
	assert.deepEqual(await database.all("SELECT n FROM events"), [{ n: 2 }]);
});

test("a write a gateway answered with HTTP 502 after the server applied it has an unknown outcome and is sent once (#4970)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const before = fake.pipelines.length;
	fake.fail({ kind: "gateway-after" });
	await assert.rejects(database.run("INSERT INTO events VALUES (1)"), (error: unknown) => {
		assert.ok(error instanceof StorageTransientError);
		assert.deepEqual([error.code, error.outcome, error.attempts], ["connection-lost", "unknown", 1]);
		return true;
	});
	assert.equal(fake.pipelines.length, before + 1, "sent once");
	assert.deepEqual(await database.all("SELECT n FROM events"), [{ n: 1 }]);
});

test("only an HTTP 5xx answer counts as a lost answer; a 4xx stays a plain StorageUnavailableError (#4970)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail({ kind: "gateway-after", status: 500 });
	await assert.rejects(database.run("INSERT INTO events VALUES (1)"), (error: unknown) => {
		assert.ok(error instanceof StorageTransientError);
		assert.equal(error.outcome, "unknown");
		return true;
	});
	fake.fail({ kind: "gateway-after", status: 499 });
	await assert.rejects(database.run("INSERT INTO events VALUES (2)"), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error instanceof StorageTransientError, false);
		return true;
	});
});

test("a failure that does not pass stays a plain StorageUnavailableError and is sent once (#4383)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	const before = fake.pipelines.length;
	await assert.rejects(database.run("INSERT INTO missing VALUES (1)"), (error: unknown) => {
		assert.ok(error instanceof StorageUnavailableError);
		assert.equal(error instanceof StorageTransientError, false);
		return true;
	});
	// After the server's `no such table`, the adapter reads the schema to see whether the table exists (#5464); the
	// statement itself is sent once.
	assert.equal(
		fake.pipelines.slice(before).filter((pipeline) => pipeline.sql.includes("INSERT INTO missing VALUES (1)")).length,
		1,
	);
});

test("several statements in one exec whose request never reached the server run again from the first, once each (#5652)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const real = globalThis.fetch;
	let carrying = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if ((await request.clone().text()).includes("VALUES (2)") && ++carrying === 1)
			throw networkFailure("ECONNREFUSED");
		return real(request);
	});
	await database.exec("INSERT INTO events VALUES (1); INSERT INTO events VALUES (2)");
	vi.unstubAllGlobals();
	assert.equal(carrying, 2, "sent again once, whole");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 1"), 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 2"), 1);
});

test("a statement of several in one exec whose rerun never reached the server fails the exec as possibly applied, and the statement before it runs once (#5652)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	// The server runs the first statement and refuses the second with SQLITE_SCHEMA; the second's own request then
	// never reaches it.
	fake.fail({ kind: "schema-changed", statement: "VALUES (2)" });
	const real = globalThis.fetch;
	let carrying = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if ((await request.clone().text()).includes("VALUES (2)") && ++carrying > 1) throw networkFailure("ECONNREFUSED");
		return real(request);
	});
	// The first statement committed: running the exec again would write it twice.
	await assert.rejects(
		database.exec("INSERT INTO events VALUES (1); INSERT INTO events VALUES (2)"),
		(error: unknown) => {
			assert.ok(error instanceof StorageTransientError);
			assert.deepEqual([error.code, error.outcome, error.attempts], ["connection-refused", "unknown", 1]);
			return true;
		},
	);
	vi.unstubAllGlobals();
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 1"), 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 2"), 0);
});

test("network codes for a connection that broke fail at once with an unknown outcome (#4383)", async () => {
	const fake = await server();
	for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"]) {
		failFirstFetch(networkFailure(code));
		await assert.rejects(openLibsqlDatabase({ url: fake.url }), (error: unknown) => {
			assert.ok(error instanceof StorageTransientError, code);
			assert.deepEqual([error.code, error.outcome, error.attempts], ["connection-lost", "unknown", 1], code);
			return true;
		});
		vi.unstubAllGlobals();
	}
});

test("only a code on the failure or its first eight causes, as a string, is read (#4383)", async () => {
	const fake = await server();
	for (const failure of [
		networkFailure("ECONNRESET", 8),
		networkFailure(111),
		new TypeError("fetch failed", { cause: "ECONNRESET" }),
		new TypeError("fetch failed", { cause: null }),
		Object.assign(new Error("server said ECONNRESET"), { code: "SERVER_ERROR" }),
	]) {
		failFirstFetch(failure);
		await assert.rejects(openLibsqlDatabase({ url: fake.url }), (error: unknown) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error instanceof StorageTransientError, false, failure.message);
			return true;
		});
		vi.unstubAllGlobals();
	}
});
