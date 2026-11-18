import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * A transaction that found the write lock busy takes the transactions directly behind it in line along once it holds
 * the lock. One being made ready to send has left the line but comes before them: it is not overtaken (#5376).
 */

/** How long, in real milliseconds, the test waits for a step it holds back to be reached; far more than any takes. */
const STEP_WAIT_MS = 5_000;

/** Looks at the writers' queue directory wait while `holdLook` is set: the first one waits for `releaseLook`. */
const looks = vi.hoisted(() => {
	let held: { readonly path: string; readonly released: Promise<void>; reached: boolean } | undefined;
	let release = () => {};
	return {
		hold(path: string) {
			held = { path, released: new Promise<void>((resolve) => (release = resolve)), reached: false };
		},
		get reached() {
			return held?.reached === true;
		},
		release() {
			release();
			held = undefined;
		},
		async before(path: string) {
			const look = held;
			if (look === undefined || path !== look.path || look.reached) return;
			look.reached = true;
			await look.released;
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		async stat(...args: Parameters<typeof actual.stat>) {
			await looks.before(String(args[0]));
			return actual.stat(...args);
		},
	};
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	looks.release();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(done: () => boolean): Promise<void> {
	const started = performance.now();
	while (!done() && performance.now() - started < STEP_WAIT_MS) await realSleep(1);
	assert.ok(done(), "the step was reached");
}

function insert(db: SqliteDatabase, n: number): Promise<unknown> {
	return db.commitStatements!([{ sql: "INSERT INTO items VALUES (?)", params: [n] }]);
}

test("a busy transaction takes along none of the calls behind one still being made ready to send (#5376)", async () => {
	const directory = makeTempDirectory("node-sqlite-pipeline-absorb-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "absorb.sqlite");
	// The test setup loads the adapter before this file's `stat` applies; load it again with it.
	vi.resetModules();
	const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
	const { interceptConnectionRequests } = await import("../helpers/sqlite-connection-requests.js");
	const db = await openNodeSqliteDatabase(path);
	cleanups.push(() => db.close());
	await db.exec("CREATE TABLE items (n INTEGER NOT NULL)");

	// Another connection holds the write lock, so the first transaction is answered busy.
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	cleanups.push(() => {
		if (other.isTransaction) other.exec("COMMIT");
		other.close();
	});
	// Its busy answer waits until the second one is being made ready and the third is in line.
	let sentFirst = false;
	let answerFirst = () => {};
	const firstMayAnswer = new Promise<void>((resolve) => (answerFirst = resolve));
	const interception = interceptConnectionRequests(async (request, send) => {
		const first = request.kind === "transaction" && request.members[0]?.[0]?.params[0] === 1;
		if (first) sentFirst = true;
		const answer = await send(request);
		if (first) await firstMayAnswer;
		return answer;
	});
	cleanups.push(interception.restore);

	const first = insert(db, 1);
	await until(() => sentFirst);
	looks.hold(`${path}-writers`);
	const second = insert(db, 2);
	await until(() => looks.reached);
	const third = insert(db, 3);
	answerFirst();
	await realSleep(50);
	other.exec("COMMIT");
	await first;
	// The second goes once the first committed, ahead of the third.
	looks.release();
	await Promise.all([second, third]);
	interception.restore();
	assert.deepEqual(
		(await db.all<{ n: number }>("SELECT n FROM items ORDER BY rowid")).map((row) => row.n),
		[1, 2, 3],
	);
});
