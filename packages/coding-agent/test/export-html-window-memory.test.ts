import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.js";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_HISTORY_PAGE_BYTES, type SessionStore } from "../src/core/storage/session/types.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

test("HTML export streams previous windows, including exact oversized Unicode entries, without hydrating them (#5554)", async () => {
	initTheme("dark");
	const dir = await mkdtemp(join(tmpdir(), "export-html-window-"));
	const store = new MemorySessionStore();
	try {
		const timestamp = new Date(0).toISOString();
		const old: SessionEntry = {
			type: "message",
			id: "large",
			parentId: null,
			timestamp,
			message: { role: "user", content: "é🚀".repeat(SESSION_HISTORY_PAGE_BYTES / 4), timestamp: 0 },
		};
		const boundary: SessionEntry = {
			type: "compaction",
			id: "window",
			parentId: old.id,
			timestamp,
			details: { strategy: "verbatim-lines" },
			summary: "cleared",
			tokensBefore: 1000,
			firstKeptEntryId: null,
		};
		await store.create({ id: "export", cwd: dir, version: 4, createdAt: timestamp }, [old, boundary]);
		const guarded: SessionStore = Object.assign(Object.create(store), {
			load: () => {
				throw new Error("HTML export read the entire store");
			},
		});
		const manager = await SessionManager.open(guarded, "export");
		const file = await exportSessionToHtml(manager, undefined, join(dir, "out.html"));
		assert.equal(manager.getEntryCount(), 1);
		const html = await readFile(file, "utf8");
		const encoded = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1];
		assert.ok(encoded);
		const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
		assert.deepEqual(data.entries, [old, boundary]);
		assert.equal(data.leafId, boundary.id);
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});
