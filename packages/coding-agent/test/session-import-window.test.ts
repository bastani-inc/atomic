import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { exportToJsonl } from "../src/core/agent-session-export.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { buildSessionContext, buildSessionIndex, getBranchPath } from "../src/core/session-manager-history.ts";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A saved JSONL session with a conversation, an abandoned branch and extension state before a clear. */
async function compactedExport(): Promise<{ file: string; directory: string }> {
	const directory = mkdtempSync(join(tmpdir(), "atomic-import-window-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const source = await JsonlSessionStore.open(join(directory, "source"), {
		exactDirectory: true,
		scanExisting: false,
	});
	cleanups.push(() => source.close());
	const writer = await SessionManager.create(source, directory);
	for (let turn = 0; turn < 6; turn++)
		await writer.appendMessage({ role: "user", content: `turn ${turn}`, timestamp: turn });
	const fork = await writer.appendMessage({ role: "user", content: "fork point", timestamp: 6 });
	await writer.appendMessage({ role: "user", content: "abandoned", timestamp: 7 });
	await writer.branch(fork);
	await writer.appendCustomEntry("plan-state", { step: 1 });
	const kept = await writer.appendMessage({ role: "user", content: "kept", timestamp: 8 });
	await writer.appendCompaction("compacted", kept, 10, {
		strategy: "verbatim-lines",
		promptVersion: 7,
		parameters: { query: "" },
		stats: {
			linesBefore: 2,
			linesDeleted: 1,
			linesKept: 1,
			rangeCount: 1,
			tokensBefore: 10,
			tokensAfter: 5,
			percentReduction: 50,
		},
		form: "cleared",
	});
	await writer.appendMessage({ role: "user", content: "after the clear", timestamp: 9 });
	return { file: writer.getSessionFile()!, directory };
}

/** What a manager holding every stored entry derived, from the rows the import saved. */
async function wholeSession(store: SessionStore, id: string) {
	const { header, entries } = await store.load(id);
	const index = buildSessionIndex([{ type: "session", ...header }, ...entries]);
	return {
		entries,
		leafId: index.leafId,
		branch: getBranchPath(index.leafId, index.byId),
		context: buildSessionContext(entries, index.leafId, index.byId),
	};
}

const texts = (entries: readonly SessionEntry[]) =>
	entries.flatMap((entry) => (entry.type === "message" ? [JSON.stringify(entry.message.content)] : []));

const targets: Record<string, (directory: string) => Promise<SessionStore>> = {
	memory: async () => new MemorySessionStore(),
	jsonl: (directory) =>
		JsonlSessionStore.open(join(directory, "target"), { exactDirectory: true, scanExisting: false }),
	sql: async (directory) => {
		const database = await openNodeSqliteDatabase(join(directory, "target.sqlite"));
		const store = await SqlSessionStore.open(database);
		cleanups.push(() => database.close());
		return store;
	},
};

for (const [kind, open] of Object.entries(targets))
	for (const via of ["static", "manager"] as const)
		test(`an import into a ${kind} store through the ${via} API keeps only the current window, as /resume does, and shows what the whole session did (#5554)`, async () => {
			const { file, directory } = await compactedExport();
			const target = await open(directory);
			cleanups.push(() => target.close());
			const imported =
				via === "static"
					? await SessionManager.importFromJsonl(file, directory, target)
					: await (await SessionManager.create(target, directory)).importFromJsonl(file);
			const id = imported.getSessionId();
			const whole = await wholeSession(target, id);
			const resumed = await SessionManager.open(target, id);

			// Retention: the conversation before the clear stays in the store, exactly as a resume leaves it.
			assert.equal(imported.hasFullHistory(), false);
			assert.ok(imported.getEntries().length < whole.entries.length);
			assert.ok(!texts(imported.getEntries()).includes(JSON.stringify("turn 0")));
			assert.deepEqual(imported.getEntries(), resumed.getEntries());

			// What the session shows and continues from is unchanged.
			assert.equal(imported.getLeafId(), whole.leafId);
			assert.deepEqual(imported.buildSessionContext(), whole.context);
			const read: SessionEntry[] = [];
			for await (const { items } of imported.readHistory())
				for (const item of items) if ("entry" in item) read.push(item.entry);
			assert.deepEqual(read, whole.entries);

			// An export of the imported session carries the whole branch, as before.
			const out = join(directory, "exported.jsonl");
			await exportToJsonl.call({ sessionManager: imported } as unknown as AgentSession, out);
			const [header, ...exported] = readFileSync(out, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(header.id, id);
			assert.deepEqual(exported, whole.branch);
		});
