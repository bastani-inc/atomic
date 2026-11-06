/**
 * Deleting a session deletes it, and the blobs it holds, from its store. The id comes from callers that do not trust
 * each other (an RPC client names it), so it is checked before the store is touched (#4326).
 */
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { SessionIdError, SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { deleteSessionFromPicker } from "../src/main-session.js";

const REFUSED_IDS: ReadonlyArray<readonly [string, string]> = [
	["a parent traversal", "../.."],
	["a single parent", ".."],
	["the current directory", "."],
	["a traversal below a name", "kept/../../.."],
	["an absolute path", "/etc"],
	["a separator", "a/b"],
	["a backslash separator", "a\\b"],
	["an empty id", ""],
	["a leading dash", "-x"],
	["a NUL byte", "a\u0000b"],
	["a traversal between names", "a/../../b"],
	["a backslash traversal", "..\\.."],
];

function refusedAs(id: string): (error: Error) => boolean {
	return (error) => {
		assert.ok(error instanceof SessionIdError);
		assert.equal(error.sessionId, id);
		return true;
	};
}

describe("a session id that is not a valid id is refused before the store is touched (#4326)", () => {
	for (const [description, id] of REFUSED_IDS) {
		test(`deleteSession refuses ${description} with a SessionIdError`, async () => {
			const store = new MemorySessionStore();
			const deletions = vi.spyOn(store, "delete");
			const manager = await SessionManager.create(store, process.cwd());

			await assert.rejects(manager.deleteSession(id), refusedAs(id));

			assert.equal(deletions.mock.calls.length, 0, "the store was not asked to delete");
		});

		test(`the --resume picker's delete refuses ${description} with a SessionIdError`, async () => {
			const store = new MemorySessionStore();
			const deletions = vi.spyOn(store, "delete");

			await assert.rejects(deleteSessionFromPicker(store, id), refusedAs(id));

			assert.equal(deletions.mock.calls.length, 0, "the store was not asked to delete");
		});
	}
});

test("the --resume picker's delete of a valid id deletes the session and its blobs (#4326, #4379)", async () => {
	const store = new MemorySessionStore();
	const doomed = await SessionManager.create(store, process.cwd());
	const kept = await SessionManager.create(store, process.cwd());
	const output = new TextEncoder().encode("a released stage's output");
	const { hash } = await store.putBlob(doomed.getSessionId(), output);
	await store.putBlob(kept.getSessionId(), output);
	const deletions = vi.spyOn(store, "delete");

	await deleteSessionFromPicker(store, doomed.getSessionId());

	assert.deepEqual(deletions.mock.calls, [[doomed.getSessionId()]]);
	assert.equal(await store.readHeader(doomed.getSessionId()), undefined);
	assert.equal(await store.getBlob(doomed.getSessionId(), hash), undefined);
	assert.deepEqual(await store.getBlob(kept.getSessionId(), hash), output);
});
