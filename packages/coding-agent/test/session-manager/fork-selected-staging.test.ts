import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { useTemporaryAgentDir } from "../../../../test/helpers/temporary-agent-dir.js";
import { SessionManager } from "../../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";

useTemporaryAgentDir();

test("a context-only SQL copy stages multiple archived receipts without decoding them together or publishing an interrupted child (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-bounded-selected-"));
	const db = await openNodeSqliteDatabase(join(dir, "test.db"));
	const source = await SqlSessionStore.open(db, { prefix: "a_" }),
		target = await SqlSessionStore.open(db, { prefix: "b_" }),
		oracle = await SqlSessionStore.open(db, { prefix: "c_" });
	try {
		const p = await SessionManager.create(source, dir),
			parentId = p.getSessionId();
		const hashes: string[] = [],
			ids: string[] = [];
		await p.appendMessage({ role: "user", content: "retired private request", timestamp: 1 });
		for (const tag of ["a", "b"]) {
			const { hash } = await source.putBlob(parentId, Buffer.from(`${tag} answer`));
			hashes.push(hash);
			ids.push(
				await p.appendCustomEntry("atomic.tool-output", {
					toolCallId: tag,
					hash,
					bytes: 8,
					opaque: tag.repeat(10 * 1024 * 1024),
				}),
			);
		}
		await p.appendCompaction("clear", null, 100, {
			strategy: "verbatim-lines",
			form: "cleared",
			promptVersion: 7,
			parameters: { query: "clear" },
			stats: {
				linesBefore: 1,
				linesDeleted: 1,
				linesKept: 0,
				rangeCount: 0,
				tokensBefore: 100,
				tokensAfter: 0,
				percentReduction: 100,
			},
		});
		await p.appendMessage({ role: "user", content: hashes.map((h) => `tool-output://${h}`).join(" "), timestamp: 2 });
		Object.defineProperty(oracle, "createFork", { value: undefined });
		const compat = await p.forkTo(dir, oracle);
		const expected = (await oracle.load(compat.getSessionId())).entries;
		const read = source.readRange.bind(source);
		source.readRange = async (...args) => {
			const page = await read(...args);
			if (args[0] === parentId)
				assert.ok(
					page.entries.every((e) => !ids.includes(e.id)),
					"decoded a selected historical receipt",
				);
			return page;
		};
		let building = false,
			expire = true;
		const stage = target.createStagedFork.bind(target);
		target.createStagedFork = async (...args) => {
			building = true;
			try {
				return await stage(...args);
			} finally {
				building = false;
			}
		};
		const chunk = source.readEntryChunk.bind(source);
		source.readEntryChunk = async (ref, off) => {
			if (building && expire && ref.seq === 3 && off === 0) {
				expire = false;
				const count = await db.get<{ n: number }>("SELECT count(*) n FROM b_session_fork_staging WHERE kind<>0");
				assert.ok(Number(count?.n) > 0);
				assert.equal(await target.readHeader("interrupted"), undefined);
				await db.run("UPDATE b_session_fork_staging SET size=0 WHERE kind=0");
				await (await SqlSessionStore.open(db, { prefix: "b_" })).close();
			}
			return chunk(ref, off);
		};
		await assert.rejects(p.forkTo(dir, target, { id: "interrupted" }), /lost its lease/);
		assert.equal(await target.readHeader("interrupted"), undefined);
		assert.equal((await db.get<{ n: number }>("SELECT count(*) n FROM b_session_fork_staging"))?.n, 0);
		const child = await p.forkTo(dir, target);
		const actual = (await target.load(child.getSessionId())).entries;
		assert.deepEqual(actual, expected);
		assert.ok(
			!actual.some(
				(e) => e.type === "message" && e.message.role === "user" && e.message.content === "retired private request",
			),
		);
		for (const h of hashes)
			assert.deepEqual(
				await target.getBlob(child.getSessionId(), h),
				await oracle.getBlob(compat.getSessionId(), h),
			);
	} finally {
		await source.close();
		await target.close();
		await oracle.close();
		await db.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);
