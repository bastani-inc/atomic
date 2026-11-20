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
