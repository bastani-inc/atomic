import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { countRows, type FakeLibsqlServer, startFakeLibsqlServer } from "../helpers/fake-libsql-server.js";
import {
	bunExecutable,
	decodeStream,
	makeTempDirectory,
	removeTempDirectory,
	spawnProcess,
} from "../helpers/runtime.js";

/**
 * How long the fake server lets a connection idle before it drops the next request on it, standing in for Turso,
 * which closes an idle connection 5 seconds after its last response: lower, as a response reaches the client after
 * the server sent it, so the client sees less idle time than the server.
 */
const SERVER_IDLE_CLOSE_MS = 4_200;
/** A pause past Node's 4-second idle timeout, which the adapter also applies on Bun, and past the server's. */
const PAUSE_PAST_IDLE_TIMEOUT_MS = 4_500;
/** A pause between two writes of an active turn, well inside every idle timeout. */
const ACTIVE_TURN_PAUSE_MS = 1_000;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface WriteOutcome {
	readonly ok: boolean;
	readonly code?: string;
	readonly outcome?: string;
}

/**
 * The adapter running under Bun in a process of its own, against `fake`, which this process keeps serving: it opens
 * the database and writes once, then for each `write(pauseMs)` waits that long and writes again.
 */
async function bunWriter(fake: FakeLibsqlServer, keepAliveMs?: number) {
	const directory = makeTempDirectory("libsql-bun-idle-");
	cleanups.push(() => removeTempDirectory(directory));
	const script = join(directory, "writer.ts");
	const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
	writeFileSync(
		script,
		`import { openLibsqlDatabase } from ${JSON.stringify(libsql)};
const database = await openLibsqlDatabase(${JSON.stringify({ url: fake.url, keepAliveMs })});
await database.exec("CREATE TABLE events(n INTEGER NOT NULL)");
await database.run("INSERT INTO events VALUES (0)");
console.log(JSON.stringify({ ok: true }));
let n = 0;
for await (const line of console) {
	await Bun.sleep(Number(line));
	try {
		await database.run("INSERT INTO events VALUES (?)", [++n]);
		console.log(JSON.stringify({ ok: true }));
	} catch (error) {
		console.log(JSON.stringify({ ok: false, code: error.code, outcome: error.outcome }));
	}
}
await database.close();
`,
	);
	const child = spawnProcess([bunExecutable(), script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
	cleanups.push(async () => {
		child.stdin?.end();
		await child.exited;
	});
	const lines = decodeStream(child.stdout!).getReader();
	let buffered = "";
	const next = async (): Promise<WriteOutcome> => {
		while (!buffered.includes("\n")) {
			const { done, value } = await lines.read();
			assert.ok(!done, "the Bun writer exited early");
			buffered += value;
		}
		const end = buffered.indexOf("\n");
		const line = buffered.slice(0, end);
		buffered = buffered.slice(end + 1);
		return JSON.parse(line) as WriteOutcome;
	};
	assert.deepEqual(await next(), { ok: true }, "the first write");
	return {
		async write(pauseMs: number): Promise<WriteOutcome> {
			child.stdin!.write(`${pauseMs}\n`);
			await child.stdin!.flush();
			return next();
		},
	};
}

async function fakeServer(idleCloseMs?: number): Promise<FakeLibsqlServer> {
	const fake = await startFakeLibsqlServer(idleCloseMs === undefined ? {} : { idleCloseMs });
	cleanups.push(() => fake.close());
	return fake;
}

test("a write on Bun after an idle pause does not reuse a connection the server is closing (#6560)", async () => {
	const fake = await fakeServer(SERVER_IDLE_CLOSE_MS);
	const writer = await bunWriter(fake);

	const warm = fake.connections;
	assert.deepEqual(await writer.write(ACTIVE_TURN_PAUSE_MS), { ok: true });
	assert.equal(fake.connections, warm, "a write during an active turn reuses the open connection");

	assert.deepEqual(
		await writer.write(PAUSE_PAST_IDLE_TIMEOUT_MS),
		{ ok: true },
		"Bun keeps an idle connection at least 8 seconds, past the server's idle timeout",
	);
	assert.equal(fake.connections, warm + 1, "the write after the pause opens a new connection");
	assert.equal(countRows(fake, "SELECT COUNT(*) AS count FROM events"), 3);
});

test("keepAliveMs keeps an idle connection open on Bun too (#6560)", async () => {
	const fake = await fakeServer();
	const writer = await bunWriter(fake, 60_000);
	const warm = fake.connections;
	assert.deepEqual(await writer.write(PAUSE_PAST_IDLE_TIMEOUT_MS), { ok: true });
	assert.equal(fake.connections, warm, "the write after the pause reuses the kept connection");
});
