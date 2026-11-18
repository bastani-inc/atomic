import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import {
	getWriterQueueStats,
	openNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

test("a waiting writer's ticket stays live on SQLite without unixepoch subsec, as on macOS 13 (#3978)", async () => {
	const configured = new WeakSet<DatabaseSync>();
	const prepare = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
		if (!configured.has(this)) {
			configured.add(this);
			this.function("unixepoch", { varargs: true }, (...args) =>
				args.includes("subsec") ? null : Math.floor(Date.now() / 1000),
			);
		}
		return prepare.call(this, sql);
	} as typeof prepare;
	const directory = makeTempDirectory("atomic-writer-clock-");
	const path = join(directory, "queue.sqlite");
	const database = await openNodeSqliteDatabase(path);
	try {
		const writers = `${path}-writers`;
		mkdirSync(writers, { recursive: true });
		mkdirSync(`${path}-wakes`, { recursive: true });
		const name = `${String(Date.now()).padStart(15, "0")}-424242-1`;
		writeFileSync(join(`${path}-wakes`, name), "");
		writeFileSync(join(writers, name), "");
		assert.equal(getWriterQueueStats(database).waiters, 1);
		assert.ok(existsSync(join(writers, name)), "a live ticket is not removed as abandoned");
	} finally {
		DatabaseSync.prototype.prepare = prepare;
		await database.close();
		removeTempDirectory(directory);
	}
});

test("the built storage module counts a waiting writer, reading the clock on the calling thread (#5376)", async () => {
	// The shipped module, compiled from this source: an emit that loses `new`'s parenthesized target throws here.
	const built = (await import(
		new URL("../../packages/coding-agent/dist/core/storage/node-sqlite.js", import.meta.url).href
	)) as typeof import("../../packages/coding-agent/src/core/storage/node-sqlite.js");
	const directory = makeTempDirectory("atomic-writer-clock-built-");
	const path = join(directory, "queue.sqlite");
	const database = await built.openNodeSqliteDatabase(path);
	try {
		const writers = `${path}-writers`;
		mkdirSync(writers, { recursive: true });
		mkdirSync(`${path}-wakes`, { recursive: true });
		const name = `${String(Date.now()).padStart(15, "0")}-424242-1`;
		writeFileSync(join(`${path}-wakes`, name), "");
		writeFileSync(join(writers, name), "");
		assert.equal(built.getWriterQueueStats(database).waiters, 1);
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});
