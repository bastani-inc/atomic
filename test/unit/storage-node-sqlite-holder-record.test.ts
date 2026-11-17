import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** How long each write to a file descriptor takes here: a disk slower than the transaction around it. */
const SLOW_WRITE_MS = 20;

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		write(...args: unknown[]) {
			setTimeout(() => (actual.write as (...writeArgs: unknown[]) => void)(...args), SLOW_WRITE_MS);
		},
	};
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("a connection's write-lock record says held while its transaction runs and free once it settled, however slow the disk (#4316)", async () => {
	const directory = makeTempDirectory("atomic-holder-record-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "records.sqlite");
	// The test setup loads the adapter before this file's slow disk applies; load it again on that disk.
	vi.resetModules();
	const { openNodeSqliteDatabase } = await import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
	const database = await openNodeSqliteDatabase(path);
	cleanups.push(() => database.close());
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const holders = `${path}-holders`;
	const record = () => {
		const [name] = readdirSync(holders).filter((entry) => entry.startsWith(`${process.pid}-`));
		return readFileSync(join(holders, name!), "utf8").slice(0, 4);
	};

	let during = "";
	await database.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('recorded')");
		during = record();
	});

	assert.equal(during, "held");
	assert.equal(record(), "free");
});
