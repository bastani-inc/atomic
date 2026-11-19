import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { collectGarbage } from "../../../../test/helpers/collect-garbage.js";
import { useTemporaryAgentDir } from "../../../../test/helpers/temporary-agent-dir.js";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.js";
import type { SqliteExecutor, SqliteRow, SqliteValue } from "../../src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";

useTemporaryAgentDir();

test("a human fork releases each oversized inline SQL snapshot before reading the next one (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-inline-snapshot-"));
	const db = await openNodeSqliteDatabase(join(dir, "test.db"));
	const tracked: WeakRef<object>[] = [];
	let recording = false,
		maxDecoded = 0,
		snapshotReads = 0;
	async function observe(rows: readonly SqliteRow[]) {
		if (!recording) return;
		const bodies = rows.flatMap((row) =>
			typeof row.entry_json === "string" && row.entry_json.length > 1024 * 1024 ? [row.entry_json] : [],
		);
		if (!bodies.length) return;
		assert.ok(
			bodies.every((s) => s.includes('"type":"worktree_snapshot"')),
			"a giant ordinary row was materialized",
		);
		await collectGarbage(3);
		maxDecoded = Math.max(maxDecoded, bodies.length + tracked.filter((ref) => ref.deref() !== undefined).length);
		snapshotReads += bodies.length;
	}
	const observeTx = (tx: SqliteExecutor): SqliteExecutor => ({
		exec: tx.exec.bind(tx),
		run: tx.run.bind(tx),
		get: async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
			const row = await tx.get<T>(sql, ...args);
			await observe(row ? [row] : []);
			return row;
		},
		all: async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
			const rows = await tx.all<T>(sql, ...args);
			await observe(rows);
			return rows;
		},
	});
	const store = await SqlSessionStore.open({
		...observeTx(db),
		descriptor: db.descriptor,
		transaction: (fn, o) => db.transaction((tx) => fn(observeTx(tx)), o),
		close: () => db.close(),
	});
	const parse = JSON.parse;
	try {
		const stamp = new Date(0).toISOString();
		const record = (id: string, parentId: string | null, bytes: number) =>
			({
				type: "worktree_snapshot",
				id,
				parentId,
				timestamp: stamp,
				root: "/work",
				snapshotId: "same",
				blobs: { fixture: "x".repeat(bytes) },
			}) as SessionEntry;
		await store.create({ id: "donor", cwd: dir, version: 4, createdAt: stamp }, []);
		let seq = 0,
			prior: string | null = null;
		for (let i = 0; i < 4; i++) {
			const id = `snap-${i}`;
			await store.append("donor", [record(id, prior, 2 * 1024 * 1024)], { expectSeq: seq++ });
			prior = id;
		}
		await store.append("donor", [record("latest", prior, 0)], { expectSeq: seq++ });
		await store.append(
			"donor",
			[
				{
					type: "message",
					id: "giant-user",
					parentId: "latest",
					timestamp: stamp,
					message: { role: "user", content: "y".repeat(2 * 1024 * 1024), timestamp: 0 },
				},
				{
					type: "compaction",
					id: "cut",
					parentId: "giant-user",
					timestamp: stamp,
					summary: "clear",
					firstKeptEntryId: null,
					tokensBefore: 100,
					details: { strategy: "verbatim-lines", form: "cleared" },
				},
				{
					type: "message",
					id: "leaf",
					parentId: "cut",
					timestamp: stamp,
					message: { role: "user", content: "current", timestamp: 1 },
				},
			],
			{ expectSeq: seq },
		);
		const manager = await SessionManager.open(store, "donor");
		JSON.parse = (text, ...args) => {
			const value = parse(text, ...args);
			if (recording && value?.type === "worktree_snapshot" && text.length > 1024 * 1024)
				tracked.push(new WeakRef(value));
			return value;
		};
		recording = true;
		await manager.createBranchedSession("leaf");
		recording = false;
		assert.equal(snapshotReads, 4);
		assert.equal(maxDecoded, 1, "more than one legacy snapshot was live at the next read");
		assert.equal((await store.load(manager.getSessionId())).entries.length, 8);
	} finally {
		recording = false;
		JSON.parse = parse;
		await store.close();
		await db.close();
		await rm(dir, { recursive: true, force: true });
	}
});
