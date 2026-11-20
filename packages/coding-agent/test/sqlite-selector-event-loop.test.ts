import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.js";
import { TestSqliteDatabase } from "./helpers/sqlite.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-sqlite-event-loop-"));
	const db = new TestSqliteDatabase(join(dir, "data.sqlite"));
	db.run("create table n (v integer)");
	// One commit for the rows: 300 commits each wait for the disk, which took 52 s on a loaded Windows runner.
	db.run("begin");
	for (let index = 0; index < 300; index++) db.run("insert into n (v) values (?)", index);
	db.run("commit");
	db.close();
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("reading a SQLite query leaves the event loop free while the statement runs", async () => {
	let ticks = 0;
	const timer = setInterval(() => {
		ticks++;
	}, 5);
	try {
		const query = encodeURIComponent("select count(*) as total from n a, n b, n c where a.v + b.v + c.v >= 0");
		const result = await createReadToolDefinition(dir).execute(
			"slow-query",
			{ path: `data.sqlite?q=${query}` },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		assert.match(text, /"total":27000000/);
	} finally {
		clearInterval(timer);
	}
	assert.ok(ticks >= 3, `the event loop ran ${ticks} timer callbacks during the query`);
});
