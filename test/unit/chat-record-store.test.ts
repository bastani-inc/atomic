import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	appendFileChatRecord,
	hasFileChatRecords,
	readFileChatRecords,
} from "../../packages/coding-agent/src/core/storage/session/jsonl-chat-records.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

for (const kind of ["memory", "JSONL", "SQLite"] as const)
	test(`${kind} keeps the whole short diagnostic and a bounded grapheme-safe preview of a long one, outside its session (#5649)`, async () => {
		const dir = makeTempDirectory("atomic-reader-records-");
		const db = kind === "SQLite" ? await openNodeSqliteDatabase(join(dir, "sessions.db")) : undefined;
		const store = db
			? await SqlSessionStore.open(db)
			: kind === "memory"
				? new MemorySessionStore()
				: await JsonlSessionStore.open(dir, { exactDirectory: true });
		try {
			const manager = await SessionManager.create(store, dir, { id: "session" });
			const anchor = await manager.appendMessage({ role: "user", content: "the first input", timestamp: 1 });
			const scope = manager.chatRecordScope();
			assert.ok(scope);
			const before = await store.load("session"),
				file = manager.getSessionFile();
			const bytes = file && (await readFile(file));
			const times = file && (await stat(file, { bigint: true })).mtimeNs;
			assert.equal(await scope.store.has(scope.owner), false);
			const text = "Error: " + "a".repeat(4058) + "👩‍🚒".repeat(9000);
			for (const value of ["Warning: short", text])
				await scope.store.append(scope.owner, anchor, { kind: "line", level: "error", text: value });
			assert.deepEqual(await store.load("session"), before);
			if (file) {
				assert.deepEqual(await readFile(file), bytes);
				assert.equal((await stat(file, { bigint: true })).mtimeNs, times);
			}
			const again = (await SessionManager.open(store, "session")).chatRecordScope();
			assert.ok(again);
			const records = await again.store.read(again.owner, [anchor]);
			assert.equal(records.length, 2);
			const a = records[0]!.record,
				b = records[1]!.record;
			assert.ok(a.kind === "line" && b.kind === "line");
			assert.equal(a.text, "Warning: short");
			assert.ok(Buffer.byteLength(b.text) <= 4096);
			assert.match(b.text, /^(?:Error: a+)(?:👩‍🚒)* … \[diagnostic truncated\]$/u);
			await store.replace("session", before.header, before.entries, { expectSeq: before.lastSeq });
			const replaced = (await SessionManager.open(store, "session")).chatRecordScope();
			assert.ok(replaced);
			assert.deepEqual(await replaced.store.read(replaced.owner, [anchor]), []);
			await store.delete("session");
			if (db) assert.equal((await db.get("SELECT count(*) AS n FROM session_chat_v1"))?.n, 0);
			else if (file) assert.ok(!(await readdir(dir)).some((f) => f.startsWith(".atomic-chat-")));
		} finally {
			await store.close();
			await db?.close();
			removeTempDirectory(dir);
		}
	});

test("a reused inode with no creation time cannot inherit deleted JSONL diagnostics (#5649)", async () => {
	const dir = makeTempDirectory("atomic-reader-unowned-");
	try {
		const owner = { id: "chat", file: join(dir, "chat.jsonl"), epoch: "1799:12:0:0123456789abcdef" };
		await appendFileChatRecord(owner, "a", { kind: "line", level: "error", text: "old chat error" });
		assert.deepEqual(await readdir(dir), []);
		assert.equal(await hasFileChatRecords(owner), false);
		assert.deepEqual(await readFileChatRecords(owner, ["a"]), []);
	} finally {
		removeTempDirectory(dir);
	}
});

test("a released memory session drops saved diagnostic bodies from the heap without losing them (#5649)", () => {
	const child = spawnSyncCollect([
		process.execPath,
		"--expose-gc",
		resolve("test/fixtures/released-chat-records.mjs"),
		process.cwd(),
	]);
	assert.equal(child.exitCode, 0, child.stderr.toString());
});

test("a foreground session append shares the paused diagnostic writer instead of failing its update (#5649)", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	const store = await SqlSessionStore.open(db);
	const gate = Promise.withResolvers<void>(),
		entered = Promise.withResolvers<void>();
	try {
		const manager = await SessionManager.create(store, process.cwd());
		const scope = manager.chatRecordScope();
		assert.ok(scope);
		const run = db.run.bind(db);
		db.run = (sql, ...params) =>
			sql.trimStart().startsWith("INSERT INTO session_chat_v1")
				? db.transaction(async (tx) => {
						entered.resolve();
						await gate.promise;
						return tx.run(sql, ...params);
					})
				: run(sql, ...params);
		const note = scope.store.append(scope.owner, "", { kind: "line", level: "error", text: "first" });
		await entered.promise;
		const user = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		gate.resolve();
		await Promise.all([note, user]);
		assert.equal(manager.getEntries().length, 1);
		assert.equal((await scope.store.read(scope.owner, [""])).length, 1);
	} finally {
		gate.resolve();
		await store.close();
		await db.close();
	}
});
