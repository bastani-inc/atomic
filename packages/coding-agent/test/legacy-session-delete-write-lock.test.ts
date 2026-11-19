/**
 * Deleting a session saved before the SQLite default records its ID in the default database, on a connection of its
 * own. Another connection of the same process may hold the write lock across turns of the event loop, as any
 * transaction that awaits between its statements does. A write on the second connection that waited for the lock in a
 * statement of its own would wait synchronously, holding the event loop, so the transaction holding the lock could not
 * end until that wait gave up (#5530).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";
import { getDefaultSessionDirPath } from "../src/core/session-manager-paths.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { LegacySessionStore } from "../src/core/storage/session/legacy-session-store.js";

/** How long the other connection's transaction holds the write lock, waiting on a timer. */
const HOLD_MS = 200;
/** A turn of the event loop longer than this is the deleting connection waiting for the lock synchronously. */
const LONGEST_TURN_MS = 1_000;

const legacyId = "0191f0a1-0000-7000-8000-0000000000a1";
let root: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "legacy-session-delete-write-lock-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv(ENV_SESSION_DIR, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function writeLegacySession(): void {
	const directory = getDefaultSessionDirPath(cwd, agentDir);
	mkdirSync(directory, { recursive: true });
	const createdAt = "2026-10-16T10:00:00.000Z";
	const lines = [
		{ type: "session", version: 4, id: legacyId, createdAt, cwd },
		{
			type: "message",
			id: "a0000001",
			parentId: null,
			timestamp: createdAt,
			message: { role: "user", content: "Saved before the database", timestamp: Date.parse(createdAt) },
		},
	];
	writeFileSync(
		join(directory, `2026-10-16T10-00-00-000Z_${legacyId}.jsonl`),
		`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
}

test.each([
	["the first time the store reads deletions, and creates their table", false],
	["after the store has read deletions", true],
] as const)(
	"deleting a legacy session while another connection of the process holds the write lock across a turn waits for it without stopping the event loop: %s (#5530)",
	async (_case, readFirst) => {
		writeLegacySession();
		const store = await resolveSessionStore(cwd, { agentDir, settings: {} });
		assert.ok(store instanceof LegacySessionStore);
		const other = await openNodeSqliteDatabase(join(agentDir, "workflows", "journal.sqlite"));
		try {
			if (readFirst) assert.equal((await store.readHeader(legacyId))?.id, legacyId);
			await other.exec("CREATE TABLE IF NOT EXISTS other_writes (at INTEGER NOT NULL)");

			let longestTurnMs = 0;
			let last = performance.now();
			let measuring = true;
			const tick = () => {
				const now = performance.now();
				longestTurnMs = Math.max(longestTurnMs, now - last);
				last = now;
				if (measuring) setTimeout(tick, 1);
			};
			setTimeout(tick, 1);
			let locked!: () => void;
			const holding = new Promise<void>((resolve) => {
				locked = resolve;
			});
			const held = other.transaction(async (transaction) => {
				await transaction.run("INSERT INTO other_writes (at) VALUES (?)", Date.now());
				locked();
				await sleep(HOLD_MS);
			});
			await holding;
			const deleted = store.delete(legacyId).then(
				() => undefined,
				(error: unknown) => error,
			);
			await held;
			const failure = await deleted;
			measuring = false;

			assert.equal(failure, undefined, "the delete failed");
			assert.ok(
				longestTurnMs < LONGEST_TURN_MS,
				`the event loop stopped for ${Math.round(longestTurnMs)} ms while the other connection held the write lock`,
			);
			assert.equal(await store.readHeader(legacyId), undefined, "the deleted legacy session is still there");
		} finally {
			await other.close();
			await store.close();
		}
	},
	30_000,
);
