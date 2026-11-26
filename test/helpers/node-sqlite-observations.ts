import assert from "node:assert/strict";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";

/** What a test can observe of an error, besides its stack. */
function shapeOf(error: unknown): unknown {
	assert.ok(error instanceof Error);
	const inherited: string[] = [];
	for (const key in error) inherited.push(key);
	return {
		constructor: error.constructor,
		prototypeIsStandard: Object.getPrototypeOf(error) === error.constructor.prototype,
		shown: String(error),
		name: error.name,
		message: error.message,
		code: (error as { code?: unknown }).code,
		ownKeys: Object.keys(error),
		spread: { ...error },
		inherited,
	};
}

/** Rows and failures a database gives back, for comparing one on a thread of its own with one in memory. */
export async function observeRowsAndFailures(database: SqliteDatabase): Promise<unknown> {
	await database.exec("CREATE TABLE values_ (n, blob, text, absent)");
	await database.run(
		"INSERT INTO values_ VALUES (?, ?, ?, ?)",
		2n ** 60n,
		new Uint8Array([0, 1, 255]),
		"text \u{1F600}",
		null,
	);
	await database.run("INSERT INTO values_ VALUES (?, ?, ?, ?)", 7, new Uint8Array(0), "", null);
	const read = await database.all("SELECT n, blob, typeof(blob) AS kind, text, absent, 1 AS __proto__ FROM values_");
	const failures: unknown[] = [];
	for (const [sql, params] of [
		["SELECT * FROM absent", []],
		["SELECT ?", [2n ** 80n]],
		["INSERT INTO values_ VALUES (1, 2, 3)", []],
	] as const) {
		const failure = await database.get(sql, ...params).then(
			() => assert.fail(`${sql} succeeded`),
			(error: unknown) => error,
		);
		assert.ok(failure instanceof Error);
		failures.push({
			outer: failure.constructor,
			message: failure.message.replace(database.descriptor.location, "<location>"),
			cause: shapeOf(failure.cause),
		});
	}
	return {
		read: read.map((row) => ({
			row,
			prototype: Object.getPrototypeOf(row) === Object.prototype,
			keys: Object.keys(row),
		})),
		failures,
	};
}

/**
 * Rows and failures a read-only transaction gives back when its calls are named as its leading reads: the reads that
 * answer, a read of a missing table, a parameter SQLite cannot bind, and a read made after them that is not one of
 * them. A database on a thread of its own sends the leading reads with its `BEGIN` (#6560); one in memory runs each
 * call as it is made. Both must give back the same.
 */
export async function observeLeadingReads(database: SqliteDatabase): Promise<unknown> {
	await database.exec("CREATE TABLE leads (n, blob, text)");
	await database.run("INSERT INTO leads VALUES (?, ?, ?)", 2n ** 60n, new Uint8Array([0, 1, 255]), "text \u{1F600}");
	await database.run("INSERT INTO leads VALUES (?, ?, ?)", 7, new Uint8Array(0), "");
	const all = "SELECT n, blob, typeof(blob) AS kind, text, 1 AS __proto__ FROM leads ORDER BY rowid";
	const one = "SELECT text FROM leads WHERE n = ?";
	const leading = [
		{ sql: all, params: [] },
		{ sql: one, params: [7] },
		{ sql: "SELECT * FROM absent", params: [] },
		{ sql: "SELECT ?", params: [2n ** 80n] },
		{ sql: one, params: [2n ** 60n] },
	];
	return database.transaction(
		async (tx) => {
			const settle = (read: Promise<unknown>) =>
				read.then(
					(value) => ({ value }),
					(error: unknown) => {
						assert.ok(error instanceof Error);
						return {
							outer: error.constructor,
							message: error.message.replace(database.descriptor.location, "<location>"),
							cause: shapeOf(error.cause),
						};
					},
				);
			const rows = await tx.all(all);
			const first = await tx.get(one, 7);
			const failures = [await settle(tx.all("SELECT * FROM absent")), await settle(tx.get("SELECT ?", 2n ** 80n))];
			const after = await tx.get(one, 2n ** 60n);
			const unled = await tx.all("SELECT count(*) AS n FROM leads");
			return {
				rows: rows.map((row) => ({ row, prototype: Object.getPrototypeOf(row) === Object.prototype })),
				first,
				failures,
				after,
				unled,
			};
		},
		{ readOnly: true, leading },
	);
}
