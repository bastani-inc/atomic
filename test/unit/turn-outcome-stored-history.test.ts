import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { releasedHistoryFiles } from "../../packages/coding-agent/src/core/storage/session/released-history-files.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

const timestamp = "2026-01-01T00:00:00Z";
const header = { version: 4, id: "chat", createdAt: timestamp, cwd: tmpdir() } as const;
const message = (id: string, parentId: string | null, content: string): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp,
	message: { role: "user", timestamp: 0, content },
});
const diagnostic = (id: string, parentId: string): SessionEntry => ({
	type: "custom",
	customType: "atomic.turn-outcome.v1",
	id,
	parentId,
	timestamp,
	data: { level: "error", text: `Compaction failed: ${"detail ".repeat(300)}` },
});
const rows = [
	message("first", null, "original prompt"),
	diagnostic("error", "first"),
	message("last", "error", "follow-up"),
];

test("export uses one session generation even when another handle replaces all three entries at the same IDs (#5649)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "atomic-outcome-export-"));
	const store = await JsonlSessionStore.open(dir, { exactDirectory: true });
	const writer = await JsonlSessionStore.open(dir, { exactDirectory: true });
	try {
		const created = await store.create(header, rows);
		const sessionManager = await SessionManager.open(store, header.id);
		const harness = await createHarness({ sessionManager });
		try {
			await writer.replace(
				header.id,
				header,
				rows.map(({ id, parentId }) => message(id, parentId, "replacement")),
				{ expectSeq: 3, epoch: created.epoch },
			);
			const path = await harness.session.exportToJsonl(join(dir, "export.jsonl"));
			const exported = (await readFile(path, "utf8"))
				.trim()
				.split("\n")
				.slice(1)
				.map((line) => JSON.parse(line));
			assert.deepEqual(exported, rows);
		} finally {
			await harness.cleanup();
		}
	} finally {
		await writer.close();
		await store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

function interleaved() {
	const entries = [...rows];
	for (let i = 0; i < 40; i++)
		entries.push(diagnostic(`error-${i}`, entries.at(-1)!.id), message(`next-${i}`, `error-${i}`, "follow-up"));
	return entries;
}

test.each(["full", "tail"] as const)(
	"walking a resident %s session uses no store loads for saved diagnostic entries (#5649)",
	async (history) => {
		const store: SessionStore = new MemorySessionStore();
		try {
			store.readRange = undefined;
			const entries = interleaved();
			await store.create(header, entries);
			const manager = await SessionManager.open(store, header.id, undefined, { history });
			const load = vi.spyOn(store, "load");
			const seen: SessionEntry[] = [];
			await manager.forEachStoredEntry(1, (entry) => {
				seen.push(entry);
			});
			assert.deepEqual(seen, entries);
			assert.equal(load.mock.calls.length, 0);
		} finally {
			await store.close();
		}
	},
);

test.each(["full", "tail"] as const)(
	"a %s reopen reads a released history once without searching the file for each diagnostic (#5649)",
	async (history) => {
		const dir = await mkdtemp(join(tmpdir(), "atomic-outcome-spill-"));
		const store = new MemorySessionStore(undefined, releasedHistoryFiles(dir));
		try {
			const entries = interleaved();
			await store.create(header, entries);
			await store.releaseSession(header.id);
			const searches = vi.spyOn(store, "findEntrySeq");
			const manager = await SessionManager.open(store, header.id, undefined, { history });
			assert.equal(manager.getLastSeq(), entries.length);
			assert.equal(searches.mock.calls.length, 0);
		} finally {
			await store.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
);
