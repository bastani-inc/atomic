import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { useTemporaryAgentDir } from "../../../../test/helpers/temporary-agent-dir.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../src/core/storage/session/types.js";

useTemporaryAgentDir();

test.each(["memory", "sqlite", "jsonl"])(
	"a human fork copies complete selected ancestry and the latest labels in bounded pages on %s (#5594)",
	async (adapter) => {
		const dir = await mkdtemp(join(tmpdir(), "human-fork-pages-"));
		const db = adapter === "sqlite" ? await openNodeSqliteDatabase(join(dir, "test.db")) : undefined;
		const store: SessionStore = db
			? await SqlSessionStore.open(db)
			: adapter === "memory"
				? new MemorySessionStore()
				: await JsonlSessionStore.open(dir, { exactDirectory: true });
		try {
			const manager = await SessionManager.create(store, dir);
			const root = await manager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			await manager.appendMessage({ role: "user", content: "sibling", timestamp: 2 });
			await manager.branch(root);
			const label = await manager.appendLabelChange(root, "old");
			const large = await manager.appendMessage({
				role: "user",
				content: "a".repeat(2 * 1024 * 1024),
				timestamp: 3,
			});
			await manager.appendCompaction("cleared", null, 300, {
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
			const leaf = await manager.appendMessage({ role: "user", content: "current", timestamp: 4 });
			await manager.appendLabelChange(root, "new");
			const parentId = manager.getSessionId();
			const before = (await store.load(parentId)).entries;
			const read = store.readRange!.bind(store);
			store.readRange = async (...args) => {
				const page = await read(...args);
				if (args[0] === parentId)
					assert.ok(
						page.entries.every((e) => e.id !== large),
						"historical row was decoded to copy it",
					);
				return page;
			};
			await manager.createBranchedSession(leaf);
			assert.equal(manager.getHeader()?.parentSessionId, parentId);
			assert.equal(manager.getEntry(large), undefined);
			const rows = (await store.load(manager.getSessionId())).entries;
			const raw = rows.find((e) => e.id === large)!;
			const original = before.find((e) => e.id === large)!;
			assert.deepEqual(raw, { ...original, parentId: root });
			assert.equal(
				rows.some((e) => e.id === label),
				false,
			);
			assert.ok(
				!rows.some((e) => e.type === "message" && e.message.role === "user" && e.message.content === "sibling"),
			);
			assert.equal(manager.getLabel(root), "new");
			assert.equal(rows.at(-1)?.parentId, leaf);
		} finally {
			await store.close();
			await db?.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
);
