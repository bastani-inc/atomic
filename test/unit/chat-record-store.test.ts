import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	appendFileChatRecord,
	hasFileChatRecords,
	readFileChatRecords,
} from "../../packages/coding-agent/src/core/storage/session/jsonl-chat-records.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import {
	MemorySessionStore,
	type SessionHistoryDirectory,
	type SessionHistoryFiles,
} from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { rowLimitedDatabase } from "../helpers/row-limited-database.js";
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

test("a file with no creation time or no inode number cannot inherit deleted JSONL diagnostics (#5649)", async () => {
	const dir = makeTempDirectory("atomic-reader-unowned-");
	try {
		for (const epoch of ["1799:12:0:0123456789abcdef", "1799:0:1763510400000000000:0123456789abcdef"]) {
			const owner = { id: "chat", file: join(dir, "chat.jsonl"), epoch };
			await appendFileChatRecord(owner, "a", { kind: "line", level: "error", text: "old chat error" });
			assert.deepEqual(await readdir(dir), [], epoch);
			assert.equal(await hasFileChatRecords(owner), false);
			assert.deepEqual(await readFileChatRecords(owner, ["a"]), []);
		}
	} finally {
		removeTempDirectory(dir);
	}
});

test("a released memory session keeps neither saved diagnostic bodies nor the responses they were cut from (#5649)", () => {
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

/** In-process history files for a memory store: reads are counted, and reads or writes can be held. */
function heldHistoryFiles() {
	const stored = new Map<number, Uint8Array>();
	const held: { reads: number; read?: Promise<void>; write?: Promise<void>; writing?: PromiseWithResolvers<void> } = {
		reads: 0,
	};
	const directory: SessionHistoryDirectory = {
		path: "held",
		async write(file, data, previous) {
			held.writing?.resolve();
			await held.write;
			const head = previous ? stored.get(previous.file)!.subarray(0, previous.bytes) : new Uint8Array(0);
			stored.set(file, Buffer.concat([head, data]));
		},
		async read(file) {
			held.reads++;
			await held.read;
			const bytes = stored.get(file);
			if (!bytes) throw Object.assign(new Error(`no file ${file}`), { code: "ENOENT" });
			return bytes;
		},
		async removeFile(file) {
			stored.delete(file);
		},
		async remove() {
			stored.clear();
		},
	};
	const files: SessionHistoryFiles = { createDirectory: async () => directory, report: () => {} };
	return { held, files };
}

for (const kind of ["memory", "JSONL", "SQLite"] as const)
	test(`${kind} finds where an admitted prompt was shown from the prompt alone, reading no diagnostic body (#5649)`, async () => {
		const dir = makeTempDirectory("atomic-reader-orders-");
		const db = kind === "SQLite" ? await openNodeSqliteDatabase(join(dir, "sessions.db")) : undefined;
		const history = heldHistoryFiles();
		const store = db
			? await SqlSessionStore.open(db)
			: kind === "memory"
				? new MemorySessionStore(undefined, history.files)
				: await JsonlSessionStore.open(dir, { exactDirectory: true });
		try {
			const manager = await SessionManager.create(store, dir, { id: "session" });
			await manager.appendMessage({ role: "user", content: "the first input", timestamp: 1 });
			const scope = manager.chatRecordScope();
			assert.ok(scope?.store.readOrders);
			await scope.store.append(scope.owner, "notice", { kind: "line", level: "error", text: "Error: offscreen" });
			await scope.store.append(scope.owner, "notice", { kind: "promptBefore", promptId: "prompt" });
			await scope.store.append(scope.owner, "later", { kind: "promptBefore", promptId: "prompt" });
			// A reader of the notice still finds the edge where it was saved, and nothing besides.
			assert.deepEqual(
				(await scope.store.read(scope.owner, ["notice"])).map(({ record }) => record.kind),
				["line", "promptBefore"],
			);
			let bodies = 0;
			if (db) {
				const all = db.all.bind(db);
				db.all = async (sql, ...params) => {
					const rows = await all(sql, ...params);
					bodies += rows.filter((row) => JSON.stringify(row).includes("offscreen")).length;
					return rows as never;
				};
			} else if (kind === "memory") {
				await (store as MemorySessionStore).releaseSession("session");
				history.held.reads = 0;
			} else
				for (const name of await readdir(dir))
					if ((await readFile(join(dir, name), "utf8")).includes("offscreen")) await unlink(join(dir, name));
			assert.deepEqual(await scope.store.readOrders(scope.owner, ["prompt", "unknown", "prompt"]), [
				{ anchor: "notice", promptId: "prompt" },
			]);
			assert.equal(bodies + history.held.reads, 0);
			const before = await store.load("session");
			await store.replace("session", before.header, before.entries, { expectSeq: before.lastSeq });
			const replaced = (await SessionManager.open(store, "session")).chatRecordScope();
			assert.deepEqual(await replaced?.store.readOrders?.(replaced.owner, ["prompt"]), []);
		} finally {
			await store.close();
			await db?.close();
			removeTempDirectory(dir);
		}
	});

test("SQLite reads every capped diagnostic of a position in replies that fit a 150 KB server (#5649)", async () => {
	const dir = makeTempDirectory("atomic-reader-pages-");
	const db = await openNodeSqliteDatabase(join(dir, "sessions.db"));
	const limited = rowLimitedDatabase(db, { maxValueBytes: 5_000_000, maxResponseBytes: 150_000 });
	const store = await SqlSessionStore.open(limited.wrapped);
	try {
		const manager = await SessionManager.create(store, dir, { id: "session" });
		const anchor = await manager.appendMessage({ role: "user", content: "the first input", timestamp: 1 });
		const scope = manager.chatRecordScope();
		assert.ok(scope);
		// Control characters are the widest a capped line's JSON gets; the rest are ordinary long errors.
		const texts = ["\u0001".repeat(5000), ...Array.from({ length: 70 }, (_, i) => `Error ${i}: ${"b".repeat(5000)}`)];
		for (const [i, text] of texts.entries())
			await scope.store.append(scope.owner, anchor, { kind: "line", id: String(i), level: "error", text });
		const records = await scope.store.read(scope.owner, [anchor]);
		assert.deepEqual(limited.refused, []);
		assert.deepEqual(
			records.map(({ record }) => record.kind === "line" && record.id),
			texts.map((_, i) => String(i)),
		);
	} finally {
		await store.close();
		await db.close();
		removeTempDirectory(dir);
	}
});

test("viewing saved diagnostics leaves another client's next SQLite listing as quiet as before; saving one re-reads it (#5649)", async () => {
	const dir = makeTempDirectory("atomic-reader-catalog-");
	const path = join(dir, "sessions.db");
	const writerDb = await openNodeSqliteDatabase(path),
		listerDb = await openNodeSqliteDatabase(path);
	const writer = await SqlSessionStore.open(writerDb),
		lister = await SqlSessionStore.open(listerDb);
	try {
		const manager = await SessionManager.create(writer, dir, { id: "session" });
		const anchor = await manager.appendMessage({ role: "user", content: "the first input", timestamp: 1 });
		const scope = manager.chatRecordScope();
		assert.ok(scope?.store.readOrders);
		await scope.store.append(scope.owner, anchor, { kind: "line", level: "error", text: "Error: saved" });
		let statements = 0;
		for (const method of ["all", "get"] as const) {
			const original = listerDb[method].bind(listerDb) as (...args: unknown[]) => Promise<unknown>;
			(listerDb as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
				statements++;
				return original(...args);
			};
		}
		const list = async () => {
			statements = 0;
			for await (const _ of lister.list({})) void _;
			return statements;
		};
		await list();
		const quiet = await list();
		assert.equal(await scope.store.has(scope.owner), true);
		assert.equal((await scope.store.read(scope.owner, [anchor])).length, 1);
		assert.deepEqual(await scope.store.readOrders(scope.owner, [anchor]), []);
		assert.equal(await list(), quiet);
		await scope.store.append(scope.owner, anchor, { kind: "line", level: "error", text: "Error: another" });
		assert.ok((await list()) > quiet);
		assert.equal(await list(), quiet);
	} finally {
		await writer.close();
		await lister.close();
		await writerDb.close();
		await listerDb.close();
		removeTempDirectory(dir);
	}
});

test("a JSONL diagnostic that cannot be written leaves the session's own writes working (#5649)", async () => {
	const dir = makeTempDirectory("atomic-reader-refused-");
	const store = await JsonlSessionStore.open(dir, { exactDirectory: true });
	try {
		const manager = await SessionManager.create(store, dir, { id: "session" });
		const anchor = await manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const scope = manager.chatRecordScope();
		const file = manager.getSessionFile();
		assert.ok(scope && file);
		// A directory holds the diagnostic index's name, so every diagnostic write of this session fails.
		const index = createHash("sha256")
			.update(JSON.stringify([basename(file), "session"]))
			.digest("hex");
		mkdirSync(join(dir, `.atomic-chat-${index}`));
		await assert.rejects(scope.store.append(scope.owner, anchor, { kind: "line", level: "error", text: "lost" }));
		await manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		assert.deepEqual(
			(await store.load("session")).entries.map(
				(entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content,
			),
			["first", "second"],
		);
		assert.equal(await scope.store.has(scope.owner), false);
	} finally {
		await store.close();
		removeTempDirectory(dir);
	}
});

test("a memory read that overlaps a release still returns the lines that release moved to files (#5649)", async () => {
	const { held, files } = heldHistoryFiles();
	const store = new MemorySessionStore(undefined, files);
	try {
		const { epoch } = await store.create(
			{ version: 4, id: "s", createdAt: "2026-01-01T00:00:00.000Z", cwd: "/" },
			[],
		);
		assert.ok(epoch);
		const owner = { id: "s", epoch };
		await store.chatRecords.append(owner, "a", { kind: "line", level: "error", text: "first" });
		await store.releaseSession("s");
		await store.chatRecords.append(owner, "a", { kind: "line", level: "error", text: "second" });
		const read = Promise.withResolvers<void>(),
			write = Promise.withResolvers<void>();
		held.read = read.promise;
		const reading = store.chatRecords.read(owner, ["a"]);
		held.write = write.promise;
		held.writing = Promise.withResolvers<void>();
		const releasing = store.releaseSession("s");
		await held.writing.promise;
		read.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		write.resolve();
		await releasing;
		assert.deepEqual(
			(await reading).map(({ record }) => record.kind === "line" && record.text),
			["first", "second"],
		);
	} finally {
		await store.close();
	}
});
