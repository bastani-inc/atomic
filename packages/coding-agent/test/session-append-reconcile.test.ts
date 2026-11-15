import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SessionDeletedError, SessionManager } from "../src/core/session-manager.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { StorageTransientError } from "../src/core/storage/errors.js";
import { SessionConflictError } from "../src/core/storage/session/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";

const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const texts = (entries: readonly SessionEntry[]) =>
	entries.flatMap((entry) => (entry.type === "message" ? [entry.message.content] : []));

/** A memory store whose next append can commit and then fail as a lost connection, and whose loads can fail. */
function faultyStore() {
	const store = new MemorySessionStore();
	let commitThenLose = false;
	let failLoads = 0;
	const lost = () =>
		new StorageTransientError(store.descriptor, { code: "connection-lost", outcome: "unknown", attempts: 1 });
	const faulty: SessionStore = Object.assign(Object.create(store) as SessionStore, {
		async append(...args: Parameters<SessionStore["append"]>) {
			const result = await store.append(...args);
			if (!commitThenLose) return result;
			commitThenLose = false;
			throw lost();
		},
		async load(sessionId: string) {
			if (failLoads > 0) {
				failLoads--;
				throw lost();
			}
			return store.load(sessionId);
		},
	});
	return {
		store,
		faulty,
		loseNextCommit(unreadableFor = 0) {
			commitThenLose = true;
			failLoads = unreadableFor;
		},
	};
}

describe("SessionManager appends after an unknown outcome (#4970)", () => {
	it("an append whose outcome could not be read back fails, and the next append takes the saved entry in (#4970)", async () => {
		const { store, faulty, loseNextCommit } = faultyStore();
		const manager = await SessionManager.create(faulty, "/project");
		await manager.appendMessage(message("one"));

		loseNextCommit(1);
		await assert.rejects(manager.appendMessage(message("two")), StorageTransientError);
		await manager.appendMessage(message("three"));
		await manager.appendMessage(message("four"));

		const stored = await store.load(manager.getSessionId());
		assert.deepEqual(texts(stored.entries), ["one", "two", "three", "four"]);
		assert.deepEqual(stored.entries, manager.getEntries());
		assert.deepEqual(texts(manager.getBranch()), ["one", "three", "four"]);
	});

	it("another writer's entries fail one append with a conflict, and later appends go on after them (#4970)", async () => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, "/project");
		await manager.appendMessage(message("one"));
		const other = await SessionManager.open(store, manager.getSessionId());
		await other.appendMessage(message("elsewhere"));

		await assert.rejects(manager.appendMessage(message("two")), SessionConflictError);
		await manager.appendMessage(message("three"));
		await manager.appendMessage(message("four"));

		const stored = await store.load(manager.getSessionId());
		assert.deepEqual(texts(stored.entries), ["one", "elsewhere", "three", "four"]);
		assert.deepEqual(stored.entries, manager.getEntries());
		assert.deepEqual(texts(manager.getBranch()), ["one", "three", "four"]);
	});
});

describe("SessionManager appends to a session deleted from its store (#4971)", () => {
	it("the first append reports the deletion once and later appends stay in memory (#4971)", async () => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, "/project");
		await manager.appendMessage(message("one"));
		await store.delete(manager.getSessionId());

		await assert.rejects(manager.appendMessage(message("two")), (error: unknown) => {
			assert.ok(error instanceof SessionDeletedError);
			assert.match(error.message, /was deleted .* no longer saved/);
			return true;
		});
		await manager.appendMessage(message("three"));

		assert.deepEqual(texts(manager.getBranch()), ["one", "three"]);
		await assert.rejects(store.load(manager.getSessionId()), /Session not found/);
	});
});
