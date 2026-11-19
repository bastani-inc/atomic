import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { useTemporaryAgentDir } from "../../../../test/helpers/temporary-agent-dir.js";
import { SessionManager } from "../../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../src/core/storage/session/types.js";

useTemporaryAgentDir();

test.each(["shared writer queue", "independent connections"])(
	"forkTo publishes whole clones through unknown SQL handles without nesting their transactions (%s; #5594)",
	async (mode) => {
		const dir = await mkdtemp(join(tmpdir(), "fork-ambiguous-sql-"));
		const a = await openNodeSqliteDatabase(join(dir, "left.db"));
		const b = mode === "shared writer queue" ? a : await openNodeSqliteDatabase(join(dir, "right.db"));
		const other = {
			descriptor: b.descriptor,
			exec: b.exec.bind(b),
			get: b.get.bind(b),
			run: b.run.bind(b),
			all: b.all.bind(b),
			transaction: b.transaction.bind(b),
			close: async () => {},
		};
		const left = await SqlSessionStore.open(a),
			right = await SqlSessionStore.open(other);
		try {
			const donor = async (store: SessionStore, tag: string) => {
				const p = await SessionManager.create(store, dir);
				const root = await p.appendMessage({ role: "user", content: tag, timestamp: 1 });
				const old = await p.appendMessage({
					role: "user",
					content: `sibling:${tag}` + ".".repeat(2 * 1024 * 1024),
					timestamp: 2,
				});
				await p.recordBranch(root);
				await p.appendMessage({ role: "user", content: `at launch ${tag}`, timestamp: 3 });
				const expected = await store.load(p.getSessionId());
				const read = store.readRange!.bind(store);
				store.readRange = async (...args) => {
					const range = await read(...args);
					if (args[0] === p.getSessionId())
						assert.ok(!range.entries.some((e) => e.id === old), "full clone materialized the retired payload");
					return range;
				};
				return { p, expected };
			};
			const l = await donor(left, "left"),
				r = await donor(right, "right");
			const [lc, rc] = await Promise.all([l.p.forkTo(dir, right), r.p.forkTo(dir, left)]);
			assert.deepEqual((await right.load(lc.getSessionId())).entries, l.expected.entries);
			assert.deepEqual((await left.load(rc.getSessionId())).entries, r.expected.entries);
		} finally {
			await left.close();
			await right.close();
			await a.close();
			if (a !== b) await b.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
	15000,
);

test.each(["memory", "reopened memory", "sqlite", "shared SQL handle", "jsonl"])(
	"forkTo clones retained and sibling history in append order on the original %s backing (#5594)",
	async (kind) => {
		const dir = await mkdtemp(join(tmpdir(), "fork-backing-"));
		const db =
			kind.includes("SQL") || kind === "sqlite" ? await openNodeSqliteDatabase(join(dir, "store.db")) : undefined;
		const source: SessionStore = db
			? await SqlSessionStore.open(db)
			: kind === "jsonl"
				? await JsonlSessionStore.open(dir, { exactDirectory: true })
				: new MemorySessionStore();
		const target =
			kind === "reopened memory"
				? await (source as MemorySessionStore).reopen()
				: kind === "shared SQL handle"
					? await SqlSessionStore.open(db!)
					: source;
		try {
			const p = await SessionManager.create(source, dir);
			const root = await p.appendMessage({ role: "user", content: "root", timestamp: 1 });
			await p.appendMessage({ role: "user", content: "sibling", timestamp: 2 });
			await p.appendLabelChange(root, "before");
			await p.recordBranch(root);
			await p.appendMessage({ role: "user", content: "retired " + "a".repeat(2 * 1024 * 1024), timestamp: 3 });
			await p.appendCompaction("cleared", null, 100, {
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
			await p.appendMessage({ role: "user", content: "current", timestamp: 4 });
			await p.appendLabelChange(root, "after");
			const original = await source.load(p.getSessionId());
			const expected = p.buildSessionContext();
			const c = await p.forkTo(dir, target);
			const copy = await target.load(c.getSessionId());
			assert.deepEqual(
				copy.entries.map((e) => e.id),
				original.entries.map((e) => e.id),
			);
			assert.deepEqual(copy.entries, original.entries);
			assert.deepEqual(c.buildSessionContext(), expected);
			assert.equal(c.getEntry(root), undefined);
			assert.equal(copy.header.parentSessionId, p.getSessionId());
		} finally {
			await source.close();
			if (target !== source) await target.close();
			await db?.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
);
