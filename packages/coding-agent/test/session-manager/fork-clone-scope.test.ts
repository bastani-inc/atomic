import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { collectGarbage } from "../../../../test/helpers/collect-garbage.js";
import { useTemporaryAgentDir } from "../../../../test/helpers/temporary-agent-dir.js";
import { SessionManager } from "../../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../src/core/storage/session/types.js";

useTemporaryAgentDir();

test("a whole clone isolates edits to its resident rows without retaining a second copy of their text (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-held-window-"));
	const path = join(dir, "session.sqlite");
	const a = await openNodeSqliteDatabase(path),
		b = await openNodeSqliteDatabase(path);
	const src = await SqlSessionStore.open(a),
		dest = await SqlSessionStore.open(b);
	try {
		const parent = await SessionManager.create(src, dir);
		await parent.forkTo(dir, dest); // Warm the same publication and restore path before measuring it.
		for (let i = 0; i < 128; i++)
			await parent.appendMessage({ role: "user", content: `${i}:${"x".repeat(256 * 1024)}`, timestamp: i });
		const id = await parent.appendCustomEntry("fixture", { nested: { value: "original" }, list: [1, 2] });
		const held = parent.getEntry(id);
		assert.ok(held?.type === "custom");
		(held.data as { nested: { value: string } }).nested.value = "edited before clone";
		await collectGarbage(3);
		const baseline = process.memoryUsage().heapUsed;
		const child = await parent.forkTo(dir, dest);
		await collectGarbage(3);
		const added = process.memoryUsage().heapUsed - baseline;
		assert.ok(
			added < 5 * 1024 * 1024,
			`the child retained ${added} more bytes while both copies of a 32 MiB window were open`,
		);
		const own = parent.getEntry(id),
			copy = child.getEntry(id);
		assert.ok(own?.type === "custom" && copy?.type === "custom");
		const original = own.data as { nested: { value: string }; list: number[] },
			cloned = copy.data as typeof original;
		assert.equal(cloned.nested.value, "edited before clone");
		const stored = (await dest.load(child.getSessionId())).entries.at(-1);
		assert.ok(stored?.type === "custom");
		assert.deepEqual(stored.data, cloned, "the published row must match the captured SDK view");
		cloned.nested.value = "child";
		original.list.push(3);
		assert.equal(original.nested.value, "edited before clone");
		assert.deepEqual(cloned.list, [1, 2]);
		assert.equal(child.getEntries().length, 129);
		assert.equal(parent.getEntries().length, 129);
		Object.defineProperty(original.nested, "value", {
			enumerable: true,
			get() {
				throw new Error("must not invoke an SDK accessor while forking");
			},
		});
		const guarded = await parent.forkTo(dir, dest);
		const fromStore = guarded.getEntry(id);
		assert.ok(fromStore?.type === "custom");
		assert.deepEqual(
			fromStore.data,
			{ nested: { value: "original" }, list: [1, 2] },
			"an accessor uses the saved view",
		);
	} finally {
		await src.close();
		await dest.close();
		await a.close();
		await b.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("a snapshot-only SDK store can clone or branch a large retired entry without repeating its compatibility load (#5594)", async () => {
	const inner = new MemorySessionStore();
	let reads = 0;
	const store: SessionStore = {
		descriptor: { adapter: "custom", location: "test" },
		create: inner.create.bind(inner),
		append: inner.append.bind(inner),
		replace: inner.replace.bind(inner),
		load: async (id) => {
			if (id === "parent") reads++;
			return inner.load(id);
		},
		readHeader: inner.readHeader.bind(inner),
		list: inner.list.bind(inner),
		delete: inner.delete.bind(inner),
		findMostRecent: inner.findMostRecent.bind(inner),
		close: inner.close.bind(inner),
	};
	try {
		const p = await SessionManager.create(store, process.cwd(), { id: "parent" });
		const old = await p.appendMessage({ role: "user", content: "x".repeat(2 * 1024 * 1024), timestamp: 0 });
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
		const leaf = await p.appendMessage({ role: "user", content: "new", timestamp: 1 });
		const original = await inner.load("parent");
		for (const kind of ["clone", "branch"]) {
			reads = 0;
			let m = p;
			if (kind === "clone") m = await p.forkTo(process.cwd(), store);
			else await p.createBranchedSession(leaf);
			assert.deepEqual((await inner.load(m.getSessionId())).entries, original.entries);
			assert.equal(m.getEntry(old), undefined);
			assert.equal(reads, 1);
		}
	} finally {
		await inner.close();
	}
});

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
