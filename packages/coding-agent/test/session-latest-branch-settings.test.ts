import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";

/** The boundary a context clear saves: everything before it leaves the window. */
const CLEARED = {
	strategy: "verbatim-lines",
	form: "cleared",
	promptVersion: 7,
	parameters: { query: "clear" },
	stats: {
		linesBefore: 2,
		linesDeleted: 2,
		linesKept: 0,
		rangeCount: 0,
		tokensBefore: 300,
		tokensAfter: 20,
		percentReduction: 93,
	},
} as const;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

type StoreKind = "jsonl" | "memory" | "sqlite";

async function newSession(kind: StoreKind): Promise<SessionManager> {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-latest-settings-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	if (kind === "jsonl") return SessionManager.create(cwd, join(cwd, "sessions"));
	if (kind === "memory") return SessionManager.create(new MemorySessionStore(), cwd);
	const database = await openNodeSqliteDatabase(join(cwd, "sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return SessionManager.create(store, cwd);
}

async function reopen(kind: StoreKind, manager: SessionManager): Promise<SessionManager> {
	return kind === "jsonl"
		? SessionManager.open(manager.getSessionFile()!, undefined, undefined, { history: "tail" })
		: SessionManager.open(manager.getSessionStore(), manager.getSessionId(), undefined, { history: "tail" });
}

const say = (manager: SessionManager, text: string) =>
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });

/** The model and level each latest setting names, and where it is. */
function described(settings: ReturnType<SessionManager["getLatestBranchSettings"]>) {
	return {
		model: settings.model && `${settings.model.entry.provider}/${settings.model.entry.modelId}@${settings.model.seq}`,
		thinkingLevel:
			settings.thinkingLevel && `${settings.thinkingLevel.entry.thinkingLevel}@${settings.thinkingLevel.seq}`,
	};
}

describe("the latest settings a session holds for its active branch", () => {
	for (const kind of ["memory", "jsonl", "sqlite"] as const) {
		test(`are held after a context clear and a reopen, whatever the window (${kind})`, async () => {
			const session = await newSession(kind);
			await session.appendModelChange("anthropic", "first");
			await session.appendThinkingLevelChange("high");
			await say(session, "one");
			const modelId = await session.appendModelChange("anthropic", "second");
			await say(session, "two");
			await session.appendCompaction("The context was cleared.", null, 300, CLEARED);
			await say(session, "three");
			const modelSeq = session.getEntrySeq(modelId)!;
			const expected = {
				model: `anthropic/second@${modelSeq}`,
				thinkingLevel: `high@${session.getEntrySeq(session.getBranch().find((e) => e.type === "thinking_level_change")!.id)}`,
			};

			const opened = await reopen(kind, session);

			assert.ok(opened.getHeldTail().fromSeq > modelSeq + 1, "both changes are before the window it holds");
			assert.deepEqual(described(session.getLatestBranchSettings()), expected);
			assert.deepEqual(described(opened.getLatestBranchSettings()), expected);
			// After a position, only what changed after it.
			assert.deepEqual(described(opened.getLatestBranchSettings(modelSeq)), {
				model: undefined,
				thinkingLevel: undefined,
			});
		});
	}

	test("are those of the active branch, not of a branch it left", async () => {
		const session = await newSession("memory");
		await session.appendModelChange("anthropic", "first");
		const forkPoint = await say(session, "one");
		await session.appendModelChange("anthropic", "abandoned");
		await session.appendThinkingLevelChange("low");
		await session.branch(forkPoint);
		await say(session, "two");

		const settings = described(session.getLatestBranchSettings());

		assert.match(settings.model ?? "", /^anthropic\/first@/);
		assert.equal(settings.thinkingLevel, undefined);
	});
});
