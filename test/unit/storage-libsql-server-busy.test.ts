import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/index.js";
import { countRows, type FakeLibsqlFault, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";

const { server, open } = useFakeLibsqlServers();

/**
 * What sqld answers a writer that meets its checkpoint: `SQLITE_BUSY` at once, without waiting, and nothing of the
 * request was run.
 */
const BUSY: FakeLibsqlFault = { kind: "busy" };

test("a transaction whose begin the server answered busy, as sqld answers a writer during its checkpoint, begins again and commits once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(BUSY);
	let runs = 0;
	await database.transaction(async (tx) => {
		runs++;
		await tx.run("INSERT INTO events VALUES (1)");
		await tx.run("INSERT INTO events VALUES (2)");
	});
	assert.equal(runs, 1);
	assert.equal(fake.pipelines.filter((pipeline) => pipeline.sql.includes("BEGIN IMMEDIATE")).length, 2);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

test("a statement outside a transaction that the server answered busy runs again and writes once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(BUSY, BUSY);
	await database.run("INSERT INTO events VALUES (1)");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

test("a statement the server answered busy on the reused stream runs again on that stream, opening no other (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (1)");
	fake.fail(BUSY);
	await database.run("INSERT INTO events VALUES (2)");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
	const second = fake.pipelines.filter((pipeline) => pipeline.sql.includes("INSERT INTO events VALUES (2)"));
	assert.deepEqual(
		second.map((pipeline) => pipeline.continuesStream),
		[true, true],
		"answered busy on the kept stream, then sent again on it",
	);
});

/**
 * The longest wait between two asks of a server that keeps answering busy (the adapter's `SERVER_BUSY_LAST_WAIT_MS`).
 * The waits begin far shorter and double, so three busy answers wait 10 + 20 + 40 ms. Waits that began at the longest
 * would take three of them however idle the machine, so that is the bound, and the rest of it is headroom for a loaded
 * machine's requests and timer wakes.
 */
const LONGEST_BUSY_WAIT_MS = 200;
/** How many times the busy insert runs. The quickest decides, so a machine that stalls during one does not. */
const SHORT_WAIT_ROUNDS = 3;

test("a server busy for a moment is asked again within a few short waits", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const took: number[] = [];
	for (let round = 1; round <= SHORT_WAIT_ROUNDS; round++) {
		fake.fail(BUSY, BUSY, BUSY);
		const started = performance.now();
		await database.run(`INSERT INTO events VALUES (${round})`);
		took.push(performance.now() - started);
	}
	assert.ok(
		Math.min(...took) < 3 * LONGEST_BUSY_WAIT_MS,
		`three busy answers cost three short waits, not ${took.map(Math.round).join(", ")} ms`,
	);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), SHORT_WAIT_ROUNDS);
});

test("a batch that the server answered busy runs again and writes once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(BUSY);
	await database.batch?.([
		{ sql: "INSERT INTO events VALUES (?)", params: [1] },
		{ sql: "INSERT INTO events VALUES (?)", params: [2] },
	]);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

test("several statements in one exec that the server answered busy run once each (#5652)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(BUSY);
	await database.exec("INSERT INTO events VALUES (1); INSERT INTO events VALUES (2)");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 1"), 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 2"), 1);
});

test("a server that stays busy past the busy timeout fails the call with its SQLITE_BUSY, having written nothing", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(...Array.from({ length: 10_000 }, () => BUSY));
	const before = fake.pipelines.length;
	const started = performance.now();
	const failure = await database.run("INSERT INTO events VALUES (1)").then(
		() => assert.fail("the insert succeeded"),
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal((failure.cause as { code?: unknown }).code, "SQLITE_BUSY");
	assert.ok(performance.now() - started >= 4_000, "it waited out the busy timeout");
	const runs = fake.pipelines.length - before;
	assert.ok(runs > 10 && runs < 60, `its waits grew instead of asking the server ${runs} times`);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
}, 20_000);

test("a statement the server answered busy after its transaction began is not run again", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const failure = await database
		.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (1)");
			fake.fail(BUSY);
			await tx.run("INSERT INTO events VALUES (2)");
		})
		.then(
			() => assert.fail("the transaction committed"),
			(error: unknown) => error,
		);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

test("a statement the server answered busy by ending the stream of its begun transaction is not run in a new transaction", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const failure = await database
		.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (1)");
			fake.fail({ kind: "stream-busy" });
			await tx.run("INSERT INTO events VALUES (2)");
		})
		.then(
			() => assert.fail("the transaction committed"),
			(error: unknown) => error,
		);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal((failure.cause as { code?: unknown }).code, "SQLITE_BUSY");
	assert.equal(fake.pipelines.filter((pipeline) => pipeline.sql.includes("BEGIN IMMEDIATE")).length, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

test("a transaction whose stream the server ended after it began does not go on in a new transaction", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const failure = await database
		.transaction(async (tx) => {
			await tx.run("INSERT INTO events VALUES (1)");
			fake.expireStreams();
			await tx.run("INSERT INTO events VALUES (2)").catch(() => undefined);
			await tx.run("INSERT INTO events VALUES (3)");
		})
		.then(
			() => assert.fail("the transaction committed"),
			(error: unknown) => error,
		);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

/**
 * What sqld answers a statement whose schema other connections kept changing while it prepared it, as on a server
 * shared by stores that create and drop their tables: `SQLITE_SCHEMA`, and nothing of the statement ran.
 */
const SCHEMA_CHANGED: FakeLibsqlFault = { kind: "schema-changed" };

test("a statement outside a transaction that the server answered schema-changed runs again and writes once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.fail(SCHEMA_CHANGED, SCHEMA_CHANGED);
	await database.run("INSERT INTO events VALUES (1)");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

test("a write whose schema-change fallback opened with an outdated schema refreshes it under the write lock (#5536)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER PRIMARY KEY)");
	await database.run("INSERT INTO events VALUES (1), (2)");
	fake.fail(SCHEMA_CHANGED, { kind: "stale-schema", table: "events" });
	assert.equal((await database.run("DELETE FROM events WHERE n = 1")).changes, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 1"), 0);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 2"), 1);
});

test("a statement in a transaction that the server answered schema-changed is not run again in it, and the transaction writes nothing", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	let runs = 0;
	await assert.rejects(
		database.transaction(async (tx) => {
			runs++;
			await tx.run("INSERT INTO events VALUES (1)");
			fake.fail(SCHEMA_CHANGED);
			await tx.run("INSERT INTO events VALUES (2)");
		}),
	);
	assert.equal(runs, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

test("a statement whose transaction the server ended with a schema-changed answer is not run again on its own", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	let runs = 0;
	await assert.rejects(
		database.transaction(async (tx) => {
			runs++;
			await tx.run("INSERT INTO events VALUES (1)");
			// The server ends the transaction it already began, rolling back the first insert.
			fake.fail({ kind: "result-error", code: "SQLITE_SCHEMA" });
			await tx.run("INSERT INTO events VALUES (2)");
		}),
	);
	assert.equal(runs, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0, "neither insert committed");
});

test("a statement of several in one exec that the server answered schema-changed runs again on its own, and a statement that ran is never sent again (#5652)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const first = "INSERT INTO events VALUES (1)";
	const second = "INSERT INTO events VALUES (2)";
	const sent = (statement: string) =>
		fake.pipelines.filter((pipeline) => pipeline.sql.some((sql) => sql.includes(statement))).length;
	// Without a refusal the statements go in one request, as the text did.
	let before = fake.pipelines.length;
	await database.exec(`${first}; ${second}`);
	assert.equal(fake.pipelines.length - before, 1);
	// The server refuses the first statement; then, in another exec, the second one after the first committed.
	for (const refused of [first, second]) {
		fake.database.exec("DELETE FROM events");
		before = sent(first);
		fake.fail({ kind: "schema-changed", statement: refused });
		await database.exec(`${first}; ${second}`);
		assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 1"), 1, refused);
		assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 2"), 1, refused);
		if (refused === second) assert.equal(sent(first) - before, 1, "the first statement ran and was not sent again");
	}
});

test("several statements in one exec that share a connection's state, such as a temporary table, are sent together and not run again after the server answered schema-changed", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	// Each statement sent on its own may run on another connection, which would not see the temporary table.
	const sql = "CREATE TEMP TABLE staged(n); INSERT INTO staged VALUES (1); INSERT INTO events SELECT n FROM staged";
	fake.fail(SCHEMA_CHANGED);
	await assert.rejects(database.exec(sql));
	assert.equal(fake.pipelines.filter((pipeline) => pipeline.sql.includes(sql)).length, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
	await database.exec(sql);
	assert.equal(
		fake.pipelines.filter((pipeline) => pipeline.sql.includes(sql)).length,
		2,
		"sent whole again by the caller",
	);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

test("a write outside a transaction lands once while other connections keep changing the server's schema longer than the adapter waits", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	fake.churnSchema(true);
	try {
		await database.run("INSERT INTO events VALUES (?)", 1);
	} finally {
		fake.churnSchema(false);
	}
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

test("a schema change in one exec lands once while other connections keep changing the server's schema longer than the adapter waits", async () => {
	const fake = await server();
	const database = await open(fake.url);
	fake.churnSchema(true);
	try {
		await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	} finally {
		fake.churnSchema(false);
	}
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'events'"), 1);
});

test("several statements in one exec land once each while other connections keep changing the server's schema longer than the adapter waits (#5652)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	fake.churnSchema(true);
	try {
		await database.exec(
			"CREATE TABLE parents (id INTEGER PRIMARY KEY); CREATE TABLE children (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED); INSERT INTO parents VALUES (1); INSERT INTO children VALUES (1, 1);",
		);
	} finally {
		fake.churnSchema(false);
	}
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM parents"), 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM children WHERE parent = 1"), 1);
});

test("a trigger created in one exec lands once while other connections keep changing the server's schema longer than the adapter waits (#5509)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE blobs(hash TEXT PRIMARY KEY, chunks INTEGER NOT NULL)");
	await database.exec("CREATE TABLE chunks(hash TEXT NOT NULL)");
	fake.churnSchema(true);
	try {
		// The body's `;` and the `END` of a `CASE` inside it belong to the one statement.
		await database.exec(
			"CREATE TRIGGER IF NOT EXISTS blobs_delete AFTER DELETE ON blobs WHEN OLD.chunks > 0 BEGIN DELETE FROM chunks WHERE hash = CASE WHEN OLD.hash = ';' THEN '' ELSE OLD.hash END; END;",
		);
	} finally {
		fake.churnSchema(false);
	}
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'blobs_delete'"), 1);
});

test("a trigger followed by another statement in one exec, the server having answered the statement schema-changed, creates the trigger once and writes once (#5509, #5652)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.exec("CREATE TABLE inserted(n INTEGER NOT NULL)");
	fake.fail({ kind: "schema-changed", statement: "INSERT INTO events VALUES (1)" });
	const trigger = "CREATE TRIGGER events_insert AFTER INSERT ON events BEGIN INSERT INTO inserted VALUES (new.n); END";
	await database.exec(`${trigger}; INSERT INTO events VALUES (1)`);
	const texts = fake.pipelines.flatMap((pipeline) => pipeline.sql);
	assert.equal(
		texts.filter((sql) => sql.includes("events_insert")).length,
		1,
		"the trigger ran once and was not sent again",
	);
	assert.ok(
		texts.every((sql) => !(sql.includes("events_insert") && sql.includes("INSERT INTO events VALUES (1)"))),
		"the trigger is never sent as one statement with the write after it",
	);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM inserted"), 1, "the trigger fired once");
});

test("a trigger whose name ends in a combining accent, a write and another trigger in one exec, the server having answered the write schema-changed, each run once (#5509, #5652)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec('CREATE TABLE events(n INTEGER NOT NULL, "case\u0301" TEXT)');
	await database.run("INSERT INTO events VALUES (0, 'ok')");
	fake.fail({ kind: "schema-changed", statement: "UPDATE events" });
	// SQLite reads `case` followed by a combining accent (U+0301) as one name, not as the keyword CASE: the first trigger
	// ends at its own END, and the UPDATE and the second trigger are statements of their own.
	const sql =
		"CREATE TRIGGER events_first AFTER INSERT ON events BEGIN SELECT new.case\u0301; END; UPDATE events SET n = n + 1; CREATE TRIGGER events_last AFTER DELETE ON events BEGIN SELECT 1; END;";
	await database.exec(sql);
	const texts = fake.pipelines.flatMap((pipeline) => pipeline.sql);
	assert.equal(
		texts.filter((text) => text.includes("events_first")).length,
		1,
		"the first trigger ran once and was not sent again",
	);
	assert.ok(
		texts.every((text) => !(/events_first|events_last/.test(text) && text.includes("UPDATE events"))),
		"a trigger is never sent as one statement with the write after it",
	);
	assert.equal(countRows(fake, "SELECT n AS count FROM events"), 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger'"), 2);
});

test("a trigger with a byte-order mark inside a literal, a quoted name, a comment or a name lands once after the server answered it schema-changed (#5509)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec('CREATE TABLE events(n INTEGER NOT NULL, "n\uFEFF" TEXT)');
	fake.fail(SCHEMA_CHANGED);
	// SQLite skips a byte-order mark where a token starts and sqld reads it as part of a name, but inside a literal, a
	// quoted name or a comment, or after a name's first character, both read it as part of that token: one trigger.
	await database.exec(
		"CREATE TRIGGER events_marked AFTER INSERT ON events BEGIN SELECT 'a\uFEFFb' AS \"a\uFEFFb\", [n\uFEFF], n\uFEFF /* \uFEFF */ FROM events; END;",
	);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'events_marked'"), 1);
});

test("one statement followed by a byte-order mark after its semicolon lands once after the server answered it schema-changed, also under churn (#5676)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	// SQLite reads the mark after the `;` as white space, and sqld runs such a text as one statement: nothing else runs.
	fake.fail(SCHEMA_CHANGED);
	await database.exec("INSERT INTO events VALUES (1);\uFEFF");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
	fake.churnSchema(true);
	try {
		await database.exec("INSERT INTO events VALUES (2);\uFEFF");
		await database.run("INSERT INTO events VALUES (3);\uFEFF");
	} finally {
		fake.churnSchema(false);
	}
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 3);
});

test("a read that starts with WITH or VALUES the server answered schema-changed is sent again as it was, while a WITH that writes lands once under churn", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	for (const sql of ["WITH x AS (SELECT 1 AS n) SELECT n FROM x", "VALUES (1)"]) {
		fake.fail(SCHEMA_CHANGED);
		await database.all(sql);
		const sent = fake.pipelines.filter((pipeline) => pipeline.sql.includes(sql));
		assert.equal(sent.length, 2, sql);
		assert.ok(
			sent.every((pipeline) => !pipeline.sql.some((statement) => /BEGIN IMMEDIATE/i.test(statement))),
			`${sql} took the write lock`,
		);
	}
	fake.churnSchema(true);
	try {
		await database.run("WITH v AS (SELECT 3 AS n) INSERT INTO events SELECT n FROM v");
	} finally {
		fake.churnSchema(false);
	}
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 1);
});

/**
 * Advances `performance.now()` by `firstDelayMs` when the first matching pipeline request settles and by
 * `retryDelayMs` on each later matching request, modelling a server whose first attempt waited out its own lock
 * timeout (sqld's 5 s `TXN_TIMEOUT`) before answering `SQLITE_BUSY` for a checkpoint.
 */
function advanceClockOnPipelines(matchSql: string, firstDelayMs: number, retryDelayMs = 0) {
	const realNow = performance.now.bind(performance);
	let offsetMs = 0;
	vi.spyOn(performance, "now").mockImplementation(() => realNow() + offsetMs);
	const realFetch = globalThis.fetch;
	let matched = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const body = await request.clone().text();
		const hit = body.includes(matchSql);
		const response = await realFetch(request);
		if (hit) {
			matched++;
			offsetMs += matched === 1 ? firstDelayMs : retryDelayMs;
		}
		return response;
	});
	return {
		get hits() {
			return matched;
		},
		reset() {
			matched = 0;
		},
	};
}

test("a call whose first attempt waited past the busy timeout before the server answered busy still gets its full retry window and writes once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const clock = advanceClockOnPipelines("INSERT INTO events", 5_500);

	// Single statement outside a transaction (`run`)
	clock.reset();
	fake.fail(BUSY, BUSY, BUSY);
	await database.run("INSERT INTO events VALUES (?)", 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 1"), 1);

	// Single-statement `exec`
	clock.reset();
	fake.fail(BUSY, BUSY, BUSY);
	await database.exec("INSERT INTO events VALUES (2)");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 2"), 1);

	// Write batch (`batch`)
	clock.reset();
	fake.fail(BUSY, BUSY, BUSY);
	await database.batch!([{ sql: "INSERT INTO events VALUES (?)", params: [3] }]);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 3"), 1);

	// Transaction whose BEGIN IMMEDIATE waited on the lock before hitting a checkpoint
	clock.reset();
	fake.fail(BUSY, BUSY, BUSY);
	let txRuns = 0;
	await database.transaction(async (tx) => {
		txRuns++;
		await tx.run("INSERT INTO events VALUES (?)", 4);
	});
	assert.equal(txRuns, 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 4"), 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 4);
});

test("a call whose retry waited past the busy timeout on the server lock after an earlier fast busy refusal still retries and writes once", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	// Attempt 1 hits a fast checkpoint (100 ms), Attempt 2 waits 5.3 s behind an abandoned lock and meets another
	// checkpoint, then Attempt 3 succeeds once the checkpoint finishes.
	const realNow = performance.now.bind(performance);
	let offsetMs = 0;
	vi.spyOn(performance, "now").mockImplementation(() => realNow() + offsetMs);
	const realFetch = globalThis.fetch;
	let matched = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const body = await request.clone().text();
		const hit = body.includes("INSERT INTO events");
		const response = await realFetch(request);
		if (hit) {
			matched++;
			offsetMs += matched === 1 ? 100 : matched === 2 ? 5_300 : 100;
		}
		return response;
	});
	fake.fail(BUSY, BUSY, BUSY);
	await database.run("INSERT INTO events VALUES (?)", 1);
	assert.equal(matched, 4);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 1"), 1);
});

test("a call whose first attempt waited 5.5 s behind an abandoned lock still recovers across a 3.5 s checkpoint before the 10 s cap", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	// Attempt 1 spends 5.5 s on the server lock, then 6 checkpoint retries spend 500 ms each plus ~510 ms backoff
	// (~9.0 s elapsed before the winning retry, past an 8 s cap but inside the 10 s cap = 5 s lock + 5 s checkpoint).
	advanceClockOnPipelines("INSERT INTO events", 5_500, 500);
	fake.fail(...Array.from({ length: 7 }, () => BUSY));
	await database.run("INSERT INTO events VALUES (?)", 1);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 1"), 1);
});

test("a call whose first attempt waited past the busy timeout still stops retrying once the 10 s call-start wall-clock cap passes", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	// Attempt 1 spends 5.5 s waiting for the lock (within the 10 s cap -> gets one probe retry); Attempt 2 also
	// spends 5.5 s (now 11 s >= 10 s cap), so the loop stops after 2 attempts instead of retrying for 20+ s.
	advanceClockOnPipelines("INSERT INTO events", 5_500, 5_500);
	fake.fail(...Array.from({ length: 100 }, () => BUSY));
	const before = fake.pipelines.length;
	const failure = await database.run("INSERT INTO events VALUES (1)").then(
		() => assert.fail("the insert succeeded"),
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal((failure.cause as { code?: unknown }).code, "SQLITE_BUSY");
	assert.equal(fake.pipelines.length - before, 2);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

test("persistent busy refusals over 200-400 ms WAN RTT stay within the 5 s busy timeout plus one RTT", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	for (const rttMs of [200, 400]) {
		const realNow = performance.now.bind(performance);
		let offsetMs = 0;
		vi.spyOn(performance, "now").mockImplementation(() => realNow() + offsetMs);
		const realFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const body = await request.clone().text();
			const hit = body.includes("INSERT INTO events");
			const response = await realFetch(request);
			if (hit) offsetMs += rttMs;
			return response;
		});
		fake.fail(...Array.from({ length: 100 }, () => BUSY));
		const started = performance.now();
		const failure = await database.run("INSERT INTO events VALUES (1)").then(
			() => assert.fail("the insert succeeded"),
			(error: unknown) => error,
		);
		const elapsed = performance.now() - started;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		assert.ok(failure instanceof StorageUnavailableError);
		assert.equal((failure.cause as { code?: unknown }).code, "SQLITE_BUSY");
		assert.ok(
			elapsed <= 5_000 + rttMs + 200,
			`${rttMs} ms RTT took ${Math.round(elapsed)} ms, expected <= ${5_000 + rttMs + 200} ms`,
		);
		assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
	}
});

test("a slow busy refusal followed by schema-changed shares the 10 s wall-clock cap across the write-transaction fallback", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	advanceClockOnPipelines("INSERT INTO events", 5_000, 5_000);
	fake.fail(BUSY, SCHEMA_CHANGED, ...Array.from({ length: 20 }, () => BUSY));
	const before = fake.pipelines.length;
	const failure = await database.run("INSERT INTO events VALUES (1)").then(
		() => assert.fail("the insert succeeded"),
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal((failure.cause as { code?: unknown }).code, "SQLITE_BUSY");
	// 1 slow BUSY + 1 slow SCHEMA_CHANGED + 1 locked write-transaction attempt (then elapsed >= 10 s -> stops immediately).
	assert.equal(fake.pipelines.length - before, 3);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

test("a server that stays busy while performance.now() does not advance still terminates within the busy timeout", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const frozen = performance.now();
	vi.spyOn(performance, "now").mockImplementation(() => frozen);
	fake.fail(...Array.from({ length: 10_000 }, () => BUSY));
	const before = fake.pipelines.length;
	const failure = await database.run("INSERT INTO events VALUES (1)").then(
		() => assert.fail("the insert succeeded"),
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal((failure.cause as { code?: unknown }).code, "SQLITE_BUSY");
	const runs = fake.pipelines.length - before;
	assert.ok(runs > 10 && runs < 60, `expected bounded retries under frozen clock, got ${runs}`);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
});

test("a slow busy or schema-changed refusal after a transaction already began still fails immediately with zero retries", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	const clock = advanceClockOnPipelines("INSERT INTO events VALUES (2)", 5_500);
	for (const fault of [BUSY, SCHEMA_CHANGED]) {
		clock.reset();
		await assert.rejects(
			database.transaction(async (tx) => {
				await tx.run("INSERT INTO events VALUES (1)");
				fake.fail(fault);
				await tx.run("INSERT INTO events VALUES (2)");
			}),
			StorageUnavailableError,
		);
		assert.equal(clock.hits, 1, `expected no retries for ${fault.kind} inside a started transaction`);
		assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 0);
	}
});
