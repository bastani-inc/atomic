import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { VerbatimCompactionDetails } from "../src/core/compaction/compaction-types.js";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const details: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 6,
	parameters: { compression_ratio: 0.5, preserve_recent: 1, query: "" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 10,
		tokensAfter: 5,
		percentReduction: 50,
	},
	rung: "planned",
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function resumedFromCompaction(): Promise<SessionManager> {
	const directory = mkdtempSync(join(tmpdir(), "atomic-tail-guard-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const database = await openNodeSqliteDatabase(join(directory, "s.sqlite"));
	const store: SessionStore = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const writer = await SessionManager.create(store, directory);
	for (let turn = 0; turn < 3; turn++)
		await writer.appendMessage({ role: "user", content: `turn ${turn}`, timestamp: 1 });
	const kept = await writer.appendMessage({ role: "user", content: "kept", timestamp: 1 });
	await writer.appendCompaction("compacted", kept, 10, details);
	const manager = await SessionManager.open(store, writer.getSessionId(), undefined, { history: "tail" });
	expect(manager.hasFullHistory()).toBe(false);
	return manager;
}

async function startWith(sessionManager: SessionManager, origin: "bundled" | undefined): Promise<boolean[]> {
	const seen: boolean[] = [];
	const extension: ExtensionFactory = (atomic) => {
		atomic.on("session_start", async (_event, ctx) => {
			seen.push(ctx.sessionManager.hasFullHistory());
		});
	};
	const extensionsResult = await createTestExtensionsResult([extension]);
	for (const loaded of extensionsResult.extensions) {
		loaded.sourceInfo = { ...loaded.sourceInfo, configurationOrigin: origin };
	}
	const harness: Harness = await createHarness({
		sessionManager,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	cleanups.push(() => harness.cleanup());
	await harness.session.bindExtensions({ shutdownHandler: () => {} });
	return seen;
}

test("starting a user extension does not hydrate a compacted session (#5554)", async () => {
	const manager = await resumedFromCompaction();
	const held = manager.getEntries();
	expect(await startWith(manager, undefined)).toEqual([false]);
	expect(manager.getEntries()).toEqual(held);
	const first = await manager.readHistory({ toSeq: 1 }).next();
	expect(first.value?.items[0]).toMatchObject({ entry: { type: "message", message: { content: "turn 0" } } });
	expect(manager.hasFullHistory()).toBe(false);
});

test("keeps a resumed session's tail for extensions Atomic bundles (#5249)", async () => {
	const manager = await resumedFromCompaction();
	expect(await startWith(manager, "bundled")).toEqual([false]);
	expect(manager.hasFullHistory()).toBe(false);
});

/** The `customType` rows on the path to the stored leaf, as a manager holding every entry returned them from
 * `getBranch()` before `loadFullHistory()` was removed. */
async function branchRowsOfWholeSession(store: SessionStore, sessionId: string, customType: string) {
	const { entries } = await store.load(sessionId);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	for (let entry = entries.at(-1); entry; entry = byId.get(entry.parentId ?? "")) path.unshift(entry);
	return path.flatMap((entry) => (entry.type === "custom" && entry.customType === customType ? [entry.data] : []));
}

test("a user extension restores its pi.appendEntry state from before the boundary at session_start, as when the whole history was loaded (#5554)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-extension-state-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const database = await openNodeSqliteDatabase(join(directory, "s.sqlite"));
	const store: SessionStore = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const writer = await SessionManager.create(store, directory);
	await writer.appendMessage({ role: "user", content: "turn 0", timestamp: 1 });
	await writer.appendCustomEntry("plan-state", { step: 1 });
	const fork = await writer.appendMessage({ role: "user", content: "turn 1", timestamp: 1 });
	await writer.appendCustomEntry("plan-state", { step: "abandoned" });
	await writer.branch(fork);
	await writer.appendCustomEntry("plan-state", { step: 2 });
	const kept = await writer.appendMessage({ role: "user", content: "kept", timestamp: 1 });
	await writer.appendCompaction("compacted", kept, 10, details);
	await writer.appendCustomEntry("plan-state", { step: 3 });
	const expected = await branchRowsOfWholeSession(store, writer.getSessionId(), "plan-state");
	expect(expected).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);

	const manager = await SessionManager.open(store, writer.getSessionId());
	expect(manager.hasFullHistory()).toBe(false);
	const seen: { branch: unknown[]; entries: unknown[] }[] = [];
	const rows = (entries: readonly SessionEntry[]) =>
		entries.flatMap((entry) => (entry.type === "custom" && entry.customType === "plan-state" ? [entry.data] : []));
	const extension: ExtensionFactory = (atomic) => {
		atomic.on("session_start", async (_event, ctx) => {
			seen.push({ branch: rows(ctx.sessionManager.getBranch()), entries: rows(ctx.sessionManager.getEntries()) });
		});
	};
	const extensionsResult = await createTestExtensionsResult([extension]);
	const harness: Harness = await createHarness({
		sessionManager: manager,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	cleanups.push(() => harness.cleanup());
	await harness.session.bindExtensions({ shutdownHandler: () => {} });

	expect(seen).toHaveLength(1);
	expect(seen[0]!.branch).toEqual(expected);
	for (const row of expected) expect(seen[0]!.entries).toContainEqual(row);
	// The conversation before the boundary stays in the store.
	expect(manager.getEntries().some((entry) => entry.type === "message" && entry.message.content === "turn 0")).toBe(
		false,
	);
});
