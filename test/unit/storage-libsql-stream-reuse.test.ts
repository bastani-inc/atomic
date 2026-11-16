import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/index.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { countRows, useFakeLibsqlServers } from "../helpers/fake-libsql-server.js";
import { makeTempDirectory, removeTempDirectory, sleep, spawnSyncCollect } from "../helpers/runtime.js";

const { server, open } = useFakeLibsqlServers();

/** The pipeline requests that ran `sql`, in order. */
function requestsRunning(fake: Awaited<ReturnType<typeof server>>, sql: string) {
	return fake.pipelines.filter((pipeline) => pipeline.sql.includes(sql));
}

test("statements outside a transaction continue one stream instead of opening one per request (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	await database.run("INSERT INTO events VALUES (?)", 2);
	const rows = await database.all<{ n: bigint }>("SELECT n FROM events ORDER BY n");
	assert.deepEqual(
		rows.map((row) => Number(row.n)),
		[1, 2],
	);
	const inserts = requestsRunning(fake, "INSERT INTO events VALUES (?)");
	const reads = requestsRunning(fake, "SELECT n FROM events ORDER BY n");
	assert.equal(inserts.length, 2);
	assert.equal(inserts[1]?.continuesStream, true, "the second insert continues the first one's stream");
	assert.equal(reads[0]?.continuesStream, true, "the read continues the same stream");
});

test("a statement whose reused stream the server expired runs once on a new stream (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	fake.expireStreams();
	await database.run("INSERT INTO events VALUES (?)", 2);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
	const second = requestsRunning(fake, "INSERT INTO events VALUES (?)").slice(1);
	assert.deepEqual(
		second.map((pipeline) => pipeline.continuesStream),
		[true, false],
		"sent on the expired stream, which ran nothing, then once on a new stream",
	);
});

test("a write whose answer is lost on the reused stream is not sent again, and the next call opens a new stream (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	fake.fail({ kind: "reset-after" });
	const failure = await database.run("INSERT INTO events VALUES (?)", 2).then(
		() => assert.fail("the insert succeeded"),
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events WHERE n = 2"), 1, "the server applied it once");
	assert.equal(requestsRunning(fake, "INSERT INTO events VALUES (?)").length, 2, "and it was never sent again");
	await database.run("INSERT INTO events VALUES (?)", 3);
	const last = requestsRunning(fake, "INSERT INTO events VALUES (?)").at(-1);
	assert.equal(last?.continuesStream, false, "the broken stream is not used again");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 3);
});

test("a read on a reused stream whose connection breaks before it is sent fails, and the next read opens a new stream (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	fake.fail({ kind: "reset-before" });
	await assert.rejects(database.get("SELECT COUNT(*) AS count FROM events"), StorageUnavailableError);
	const row = await database.get<{ count: bigint }>("SELECT COUNT(*) AS count FROM events");
	assert.equal(Number(row?.count), 1);
	assert.equal(requestsRunning(fake, "SELECT COUNT(*) AS count FROM events").at(-1)?.continuesStream, false);
});

test("a stream idle longer than the reuse bound is closed and a new one is opened, before the server would expire it (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	const now = performance.now();
	vi.spyOn(performance, "now").mockImplementation(() => now + 6_000);
	await database.run("INSERT INTO events VALUES (?)", 2);
	assert.equal(requestsRunning(fake, "INSERT INTO events VALUES (?)").at(-1)?.continuesStream, false);
	assert.equal(fake.expiredStatements, 0, "no statement met an expired stream");
	await vi.waitFor(() =>
		assert.ok(
			fake.pipelines.some((pipeline) => pipeline.continuesStream && pipeline.sql.length === 0),
			"the idle stream was closed",
		),
	);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2);
});

test("schema changes, pragmas and transaction control never run on the reused stream (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.run("SELECT 1");
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.get("PRAGMA foreign_keys");
	for (const sql of ["CREATE TABLE events(n INTEGER NOT NULL)", "PRAGMA foreign_keys"])
		assert.ok(
			requestsRunning(fake, sql).every((pipeline) => !pipeline.continuesStream),
			`${sql} ran on a stream of its own`,
		);
});

test("comments before a statement's keyword decide its stream as the keyword alone does (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	const commentedRead = "/* lead */ -- note\n  SELECT n FROM events";
	const commentedSchemaChange = "/* lead */ CREATE TABLE other(n INTEGER)";
	const unclosedComment = "/* open comment SELECT n FROM events";
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	await database.all(commentedRead);
	await database.run(commentedSchemaChange);
	await database.all(unclosedComment).catch(() => undefined);
	assert.equal(
		requestsRunning(fake, commentedRead)[0]?.continuesStream,
		true,
		"a commented read continues the stream",
	);
	assert.equal(
		requestsRunning(fake, commentedSchemaChange)[0]?.continuesStream,
		false,
		"a commented schema change does not",
	);
	const unclosed = requestsRunning(fake, unclosedComment);
	assert.ok(unclosed.length > 0, "the statement with an unclosed comment was sent");
	assert.ok(
		unclosed.every((pipeline) => !pipeline.continuesStream),
		"an unclosed comment hides the keyword, so it runs on a stream of its own",
	);
});

/** Comments in a statement's prefix that a backtracking pattern splits in 2^n ways before rejecting the statement. */
const AMBIGUOUS_COMMENT_RUNS = 40;
/**
 * How long a Node child process may take to open a database and run one statement. Node, as npm installs run Atomic:
 * its regular expression engine is the one that backtracked on such a prefix.
 */
const CLASSIFY_PROCESS_BOUND_MS = 20_000;
/** The test's own budget: it runs a real child process, bounded above. */
const CLASSIFY_PROCESS_TEST_TIMEOUT_MS = 2 * CLASSIFY_PROCESS_BOUND_MS;

test(
	"a statement led by comments that can be split many ways is classified at once",
	() => {
		const directory = makeTempDirectory("libsql-comment-prefix-");
		try {
			const script = join(directory, "classify.mjs");
			const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
			writeFileSync(
				script,
				`import { openLibsqlDatabase } from ${JSON.stringify(pathToFileURL(libsql).href)};
const database = await openLibsqlDatabase({ url: ${JSON.stringify(pathToFileURL(join(directory, "store.sqlite")).href)} });
const row = await database.get("/*" + "*//*".repeat(${AMBIGUOUS_COMMENT_RUNS}) + "*/ PRAGMA user_version");
console.log(JSON.stringify(row));
await database.close();
`,
			);
			const result = spawnSyncCollect([process.execPath, script], { timeout: CLASSIFY_PROCESS_BOUND_MS });
			assert.equal(result.exitCode, 0, result.stderr.toString());
			assert.equal(result.stdout.toString().trim(), JSON.stringify({ user_version: 0 }));
		} finally {
			removeTempDirectory(directory);
		}
	},
	CLASSIFY_PROCESS_TEST_TIMEOUT_MS,
);

test("a transaction keeps a stream of its own while statements outside it reuse theirs (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO events VALUES (?)", 2);
		await tx.run("INSERT INTO events VALUES (?)", 3);
	});
	await database.run("INSERT INTO events VALUES (?)", 4);
	const begins = fake.pipelines.filter((pipeline) => pipeline.sql.some((sql) => /^BEGIN/i.test(sql)));
	assert.equal(begins.length, 1);
	assert.equal(begins[0]?.continuesStream, false, "the transaction began on a stream of its own");
	const outside = requestsRunning(fake, "INSERT INTO events VALUES (?)").filter(
		(pipeline) => !begins.includes(pipeline),
	);
	assert.deepEqual(
		outside.map((pipeline) => pipeline.continuesStream),
		[false, true],
		"the insert after the transaction continued the first insert's stream",
	);
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 4);
});

test("a statement whose kept stream's baton the server refused, as sqld does before running anything, runs once on a new stream (#5151)", async () => {
	for (const message of [
		"Received an invalid baton",
		"Received a baton that has already been used",
		"Stream for this baton was closed",
	]) {
		const fake = await server();
		const database = await open(fake.url);
		await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
		await database.run("INSERT INTO events VALUES (?)", 1);
		fake.fail({ kind: "bad-request", message });
		await database.run("INSERT INTO events VALUES (?)", 2);
		assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 2, message);
		assert.deepEqual(
			requestsRunning(fake, "INSERT INTO events VALUES (?)")
				.slice(1)
				.map((pipeline) => pipeline.continuesStream),
			[true, false],
			`${message}: refused on the kept stream, then sent once on a new one`,
		);
	}
});

test("any other HTTP 400 on the kept stream is not sent again, since it may follow a request that ran (#5151)", async () => {
	const fake = await server();
	const database = await open(fake.url);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	fake.fail({ kind: "bad-request", message: "SQL text 1 not found" });
	await assert.rejects(database.run("INSERT INTO events VALUES (?)", 2), StorageUnavailableError);
	assert.equal(requestsRunning(fake, "INSERT INTO events VALUES (?)").length, 2, "sent once");
	await database.run("INSERT INTO events VALUES (?)", 3);
	assert.equal(
		requestsRunning(fake, "INSERT INTO events VALUES (?)").at(-1)?.continuesStream,
		false,
		"the refused stream is not used again",
	);
});

test("closing the database waits for its reused stream's close to be answered (#5151)", async () => {
	const fake = await server();
	const database = await openLibsqlDatabase({ url: fake.url });
	await database.run("SELECT 1");
	let answered = false;
	fake.onStreamClose(async () => {
		await sleep(300);
		answered = true;
	});
	await database.close();
	assert.equal(answered, true, "the close was answered before the database finished closing");
});

test("closing the database does not wait long for a server that never answers its stream's close (#5151)", async () => {
	const fake = await server();
	const database = await openLibsqlDatabase({ url: fake.url });
	await database.run("SELECT 1");
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	fake.onStreamClose(() => held);
	const started = performance.now();
	await database.close();
	const took = performance.now() - started;
	release();
	assert.ok(took >= 900 && took < 3_000, `closed after ${Math.round(took)} ms`);
});

test("a libsql: URL reuses its stream as an http: URL does (#5151)", async () => {
	const fake = await server();
	const database = await open(`libsql://127.0.0.1:${fake.port}?tls=0`);
	await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
	await database.run("INSERT INTO events VALUES (?)", 1);
	await database.run("INSERT INTO events VALUES (?)", 2);
	assert.deepEqual(
		requestsRunning(fake, "INSERT INTO events VALUES (?)").map((pipeline) => pipeline.continuesStream),
		[false, true],
	);
});

test("a remote database whose Hrana client cannot load fails to open, naming that module (#5151)", async () => {
	vi.resetModules();
	vi.doMock("@libsql/hrana-client", () => {
		throw new Error("not installed");
	});
	const { openLibsqlDatabase: openFresh } = await import("../../packages/storage-libsql/libsql.js");
	await assert.rejects(openFresh({ url: "http://127.0.0.1:9" }), (error: unknown) => {
		// A fresh module graph loads its own copy of the error class, so it is told by its name.
		assert.equal((error as Error).name, "StorageAdapterLoadError");
		assert.equal((error as { module?: unknown }).module, "@libsql/hrana-client");
		return true;
	});
	vi.doUnmock("@libsql/hrana-client");
	vi.resetModules();
});
