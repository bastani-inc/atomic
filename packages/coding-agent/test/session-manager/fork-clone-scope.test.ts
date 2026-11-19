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
