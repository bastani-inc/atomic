import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SessionDeletedError, SessionManager } from "../src/core/session-manager.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { StorageTransientError } from "../src/core/storage/errors.js";
import { SessionConflictError, SessionNotFoundError } from "../src/core/storage/session/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionStore } from "../src/core/storage/session/types.js";

const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const texts = (entries: readonly SessionEntry[]) =>
	entries.flatMap((entry) => (entry.type === "message" ? [entry.message.content] : []));

/**
 * A memory store whose appends can lose the connection, as a database server's can: after the server committed the
 * append, or before it did. Either way the append reports an unknown outcome. Loads can fail the same way.
 */
function faultyStore() {
	const store = new MemorySessionStore();
	let lose: "after-commit" | "before-commit" | undefined;
	let losses = 0;
	let failLoads = 0;
	let appends = 0;
	const lost = () =>
		new StorageTransientError(store.descriptor, { code: "connection-lost", outcome: "unknown", attempts: 1 });
	const faulty: SessionStore = Object.assign(Object.create(store) as SessionStore, {
		async append(...args: Parameters<SessionStore["append"]>) {
			appends++;
			if (losses === 0) return store.append(...args);
			losses--;
			if (lose === "after-commit") await store.append(...args);
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
		appends: () => appends,
		/** The next `times` appends lose the connection; the next `unreadableFor` loads fail. */
		loseConnection(when: "after-commit" | "before-commit", times = 1, unreadableFor = 0) {
			lose = when;
			losses = times;
			failLoads = unreadableFor;
		},
	};
}

describe("SessionManager appends after an unknown outcome (#4970)", () => {
	it("an append the server committed before the connection broke is recognised as saved, once (#4970)", async () => {
		const { store, faulty, loseConnection } = faultyStore();
		const manager = await SessionManager.create(faulty, "/project");
		await manager.appendMessage(message("one"));

		loseConnection("after-commit");
		await manager.appendMessage(message("two"));
		await manager.appendMessage(message("three"));

		const stored = await store.load(manager.getSessionId());
		assert.deepEqual(texts(stored.entries), ["one", "two", "three"]);
		assert.deepEqual(stored.entries, manager.getEntries());
		assert.deepEqual(texts(manager.getBranch()), ["one", "two", "three"]);
	});

	it("an append the connection lost before the server committed it is written once more (#4970)", async () => {
		const { store, faulty, loseConnection } = faultyStore();
		const manager = await SessionManager.create(faulty, "/project");
		await manager.appendMessage(message("one"));

		loseConnection("before-commit");
		await manager.appendMessage(message("two"));

		const stored = await store.load(manager.getSessionId());
		assert.deepEqual(texts(stored.entries), ["one", "two"]);
		assert.deepEqual(stored.entries, manager.getEntries());
		assert.deepEqual(texts(manager.getBranch()), ["one", "two"]);
	});

	it("an append whose connection keeps breaking fails after four tries (#4970)", async () => {
		const { store, faulty, appends, loseConnection } = faultyStore();
		const manager = await SessionManager.create(faulty, "/project");
		await manager.appendMessage(message("one"));
		const before = appends();

		loseConnection("before-commit", 10);
		await assert.rejects(manager.appendMessage(message("two")), StorageTransientError);

		assert.equal(appends() - before, 4);
		assert.deepEqual(texts((await store.load(manager.getSessionId())).entries), ["one"]);
		assert.deepEqual(texts(manager.getEntries()), ["one"]);
	});

	it("an append that failed without writing anything is not tried again (#4970)", async () => {
		const store = new MemorySessionStore();
		const failures = [
			new StorageTransientError(store.descriptor, {
				code: "connection-refused",
				outcome: "not-applied",
				attempts: 3,
			}),
			new Error("disk full"),
		];
		let appends = 0;
		const failing: SessionStore = Object.assign(Object.create(store) as SessionStore, {
			async append(...args: Parameters<SessionStore["append"]>) {
				appends++;
				const failure = appends > 1 ? failures.shift() : undefined;
				if (failure !== undefined) throw failure;
				return store.append(...args);
			},
		});
		const manager = await SessionManager.create(failing, "/project");
		await manager.appendMessage(message("one"));

		await assert.rejects(manager.appendMessage(message("two")), StorageTransientError);
		await assert.rejects(manager.appendMessage(message("three")), /disk full/);
		await manager.appendMessage(message("four"));

		assert.equal(appends, 4);
		assert.deepEqual(texts((await store.load(manager.getSessionId())).entries), ["one", "four"]);
		assert.deepEqual(texts(manager.getEntries()), ["one", "four"]);
	});

	it("an append whose outcome could not be read back fails, and the next append takes the saved entry in (#4970)", async () => {
		const { store, faulty, loseConnection } = faultyStore();
		const manager = await SessionManager.create(faulty, "/project");
		await manager.appendMessage(message("one"));

		loseConnection("after-commit", 1, 1);
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

	it("another writer's first entries in a new session fail one append, and later appends go on (#4970)", async () => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, "/project");
		const other = await SessionManager.open(store, manager.getSessionId());
		await other.appendMessage(message("elsewhere"));

		await assert.rejects(manager.appendMessage(message("one")), SessionConflictError);
		await manager.appendMessage(message("two"));

		const stored = await store.load(manager.getSessionId());
		assert.deepEqual(texts(stored.entries), ["elsewhere", "two"]);
		assert.deepEqual(stored.entries, manager.getEntries());
		assert.deepEqual(texts(manager.getBranch()), ["two"]);
	});

	it("a store whose history was cut short fails the append and is not taken in (#4970)", async () => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, "/project");
		await manager.appendMessage(message("one"));
		await manager.appendMessage(message("two"));
		const other = await SessionManager.create(store, "/project");
		await other.appendMessage(message("x"));
		const header = (await store.load(manager.getSessionId())).header;
		await store.replace(manager.getSessionId(), header, other.getEntries(), { expectSeq: 2 });

		await assert.rejects(manager.appendMessage(message("three")), SessionConflictError);

		assert.deepEqual(texts(manager.getEntries()), ["one", "two"]);
	});

	it("a store whose history no longer extends the manager's fails the append and is not taken in (#4970)", async () => {
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, "/project");
		await manager.appendMessage(message("one"));
		const other = await SessionManager.create(store, "/project");
		await other.appendMessage(message("x"));
		await other.appendMessage(message("y"));
		const header = (await store.load(manager.getSessionId())).header;
		await store.replace(manager.getSessionId(), header, other.getEntries(), { expectSeq: 1 });

		await assert.rejects(manager.appendMessage(message("two")), SessionConflictError);

		assert.deepEqual(texts(manager.getEntries()), ["one"]);
		assert.deepEqual(texts((await store.load(manager.getSessionId())).entries), ["x", "y"]);
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
			assert.equal(error.name, "SessionDeletedError");
			assert.equal(error.sessionId, manager.getSessionId());
			assert.ok(error.cause instanceof SessionNotFoundError);
			assert.match(error.message, /was deleted .* no longer saved/);
			return true;
		});
		await manager.appendMessage(message("three"));

		assert.deepEqual(texts(manager.getBranch()), ["one", "three"]);
		await assert.rejects(store.load(manager.getSessionId()), SessionNotFoundError);

		await manager.newSession();
		await manager.appendMessage(message("saved again"));
		assert.deepEqual(texts((await store.load(manager.getSessionId())).entries), ["saved again"]);
	});
});
