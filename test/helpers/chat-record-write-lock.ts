/**
 * #5682: a saved turn diagnostic must wait for another process's SQLite write lock the way the session's own writes do,
 * without stopping this process's event loop: node:sqlite waits out `busy_timeout` synchronously for a statement
 * outside a transaction. Shared by the Node test and its Bun child, since Atomic's binary runs on Bun's node:sqlite.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ChatRecord } from "../../packages/coding-agent/src/core/storage/session/chat-records.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "./runtime.js";
import { holdSqliteWriteLock } from "./sqlite-lock-holder.js";

/**
 * How long the other process keeps the lock, short of the 5 s busy timeout so that the write waits for it and then
 * commits, and the longest event-loop turn a write may take meanwhile. A write that waited for the lock on this thread
 * would stop the event loop until the busy timeout ran out. On a loaded Windows runner the event loop goes up to about
 * 1.4 s without a turn on Bun and 0.5 s on Node while another process holds the lock, whether or not anything is
 * being written.
 */
const LOCK_HELD_MS = 3_000;
const LONGEST_TURN_MS = 2_000;
/**
 * Each case holds the lock twice and starts a lock holder process for each hold. A loaded Windows runner takes several
 * seconds to start one.
 */
export const CHAT_RECORD_LOCK_CASE_BUDGET_MS = 60_000;

export const CHAT_RECORD_LOCK_CASES = [
	"the first diagnostic, which creates its table",
	"a later diagnostic",
	"a prompt's order edge",
] as const;
export type ChatRecordLockCase = (typeof CHAT_RECORD_LOCK_CASES)[number];

/**
 * The longest this process went without an event-loop turn while `write` waited for the write lock another process
 * held for `LOCK_HELD_MS`, and whether `write` had settled before that process let go.
 */
async function whileAnotherProcessHoldsTheLock(path: string, write: () => Promise<unknown>) {
	const holder = await holdSqliteWriteLock(path);
	let longestTurnMs = 0,
		last = performance.now(),
		ticking = true;
	const tick = () => {
		const now = performance.now();
		longestTurnMs = Math.max(longestTurnMs, now - last);
		last = now;
		if (ticking) setTimeout(tick, 1);
	};
	setTimeout(tick, 1);
	let settled = false;
	const writing = write()
		.then(
			() => undefined,
			(error: unknown) => error,
		)
		.finally(() => {
			settled = true;
		});
	let settledWhileHeld: boolean;
	try {
		await sleep(LOCK_HELD_MS);
	} finally {
		settledWhileHeld = settled;
		await holder.release();
	}
	const failure = await writing;
	ticking = false;
	return { longestTurnMs, settledWhileHeld, failure };
}

/**
 * Runs one case against a session in a SQLite file: main's ordinary append, then the saved diagnostic, each while
 * another process holds the file's write lock. Asserts neither stops the event loop, and both wait for the lock and
 * then commit.
 */
export async function assertChatRecordWaitsWithoutStoppingTheEventLoop(which: ChatRecordLockCase): Promise<void> {
	const directory = makeTempDirectory("atomic-chat-record-lock-");
	const path = join(directory, "sessions.db");
	const database = await openNodeSqliteDatabase(path);
	const store = await SqlSessionStore.open(database);
	try {
		const manager = await SessionManager.create(store, directory, { id: "session" });
		const anchor = await manager.appendMessage({ role: "user", content: "the first input", timestamp: 1 });
		const scope = manager.chatRecordScope();
		assert.ok(scope);
		if (which !== CHAT_RECORD_LOCK_CASES[0])
			await scope.store.append(scope.owner, anchor, { kind: "line", level: "error", text: "Error: an earlier one" });

		// Main's own write under the same lock: the baseline this process already keeps responsive.
		const tree = await whileAnotherProcessHoldsTheLock(path, () =>
			manager.appendMessage({ role: "user", content: "the second input", timestamp: 2 }),
		);
		assert.equal(tree.failure, undefined);
		assert.ok(
			tree.longestTurnMs < LONGEST_TURN_MS,
			`main's append stopped the event loop for ${Math.round(tree.longestTurnMs)} ms`,
		);

		const record: ChatRecord =
			which === CHAT_RECORD_LOCK_CASES[2]
				? { kind: "promptBefore", promptId: manager.getLeafId()! }
				: { kind: "line", level: "error", text: "Error: Retry failed after 1 attempts: Retry cancelled" };
		const side = await whileAnotherProcessHoldsTheLock(path, () => scope.store.append(scope.owner, anchor, record));
		assert.ok(
			side.longestTurnMs < LONGEST_TURN_MS,
			`saving ${which} stopped the event loop for ${Math.round(side.longestTurnMs)} ms (main's append: ${Math.round(tree.longestTurnMs)} ms)`,
		);
		assert.equal(side.failure, undefined);
		assert.equal(side.settledWhileHeld, false, `${which} was saved while another process held the write lock`);
		const saved =
			record.kind === "promptBefore"
				? await scope.store.readOrders?.(scope.owner, [record.promptId])
				: (await scope.store.read(scope.owner, [anchor])).map((row) => row.record);
		assert.deepEqual(saved?.at(-1), record.kind === "promptBefore" ? { anchor, promptId: record.promptId } : record);
	} finally {
		await store.close();
		await database.close();
		removeTempDirectory(directory);
	}
}
