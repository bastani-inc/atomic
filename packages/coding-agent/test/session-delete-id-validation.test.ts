/**
 * Deleting a session removes its released-stage tool results from the agent directory. The id comes from callers
 * that do not trust each other (an RPC client names it), so it is checked before anything is touched (#4326).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { SessionIdError, SessionManager } from "../src/core/session-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import { getReleasedStageBlobDir, removeReleasedStageBlobs } from "../src/core/tools/tool-output-blobs.ts";
import { deleteSessionFromPicker } from "../src/main-session.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, rm: vi.fn(actual.rm) };
});

const removals = vi.mocked(fsPromises.rm);
const directories: string[] = [];
afterEach(() => {
	removals.mockClear();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

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

function agentDirectoryWithSentinel(): { readonly agentDir: string; readonly sentinel: string } {
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-delete-id-"));
	directories.push(agentDir);
	const sentinel = join(agentDir, "auth.json");
	writeFileSync(sentinel, "{}");
	mkdirSync(getReleasedStageBlobDir(agentDir, "stage-session"), { recursive: true });
	return { agentDir, sentinel };
}

describe("a session id that could leave the blob directory is refused before any removal (#4326)", () => {
	for (const [description, id] of REFUSED_IDS) {
		test(`deleteSession refuses ${description} with a SessionIdError and touches nothing`, async () => {
			const { agentDir, sentinel } = agentDirectoryWithSentinel();
			const store = new MemorySessionStore();
			const deletions = vi.spyOn(store, "delete");
			const manager = await SessionManager.create(store, process.cwd());
			manager.bindAgentDir(agentDir);

			await assert.rejects(manager.deleteSession(id), (error: Error) => {
				assert.ok(error instanceof SessionIdError);
				assert.equal((error as SessionIdError).sessionId, id);
				return true;
			});

			assert.equal(deletions.mock.calls.length, 0, "the store was not asked to delete");
			assert.equal(removals.mock.calls.length, 0, "no directory removal was attempted");
			assert.equal(existsSync(sentinel), true);
			assert.equal(existsSync(getReleasedStageBlobDir(agentDir, "stage-session")), true);
		});

		test(`the --resume picker's delete refuses ${description} with a SessionIdError before the store or the disk is touched`, async () => {
			const { agentDir, sentinel } = agentDirectoryWithSentinel();
			const store = new MemorySessionStore();
			const deletions = vi.spyOn(store, "delete");

			await assert.rejects(deleteSessionFromPicker(store, agentDir, id), (error: Error) => {
				assert.ok(error instanceof SessionIdError);
				assert.equal((error as SessionIdError).sessionId, id);
				return true;
			});

			assert.equal(deletions.mock.calls.length, 0, "the store was not asked to delete");
			assert.equal(removals.mock.calls.length, 0, "no directory removal was attempted");
			assert.equal(existsSync(sentinel), true);
		});

		test(`removeReleasedStageBlobs refuses ${description} with a SessionIdError and removes nothing`, async () => {
			const { agentDir, sentinel } = agentDirectoryWithSentinel();

			await assert.rejects(removeReleasedStageBlobs(agentDir, id), SessionIdError);

			assert.equal(removals.mock.calls.length, 0, "no directory removal was attempted");
			assert.equal(existsSync(sentinel), true);
		});
	}

	test("a valid id removes exactly that session's blob directory", async () => {
		const { agentDir, sentinel } = agentDirectoryWithSentinel();
		mkdirSync(getReleasedStageBlobDir(agentDir, "other-session"), { recursive: true });

		await removeReleasedStageBlobs(agentDir, "stage-session");

		assert.equal(removals.mock.calls.length, 1);
		assert.equal(existsSync(getReleasedStageBlobDir(agentDir, "stage-session")), false);
		assert.equal(existsSync(getReleasedStageBlobDir(agentDir, "other-session")), true);
		assert.equal(existsSync(sentinel), true);
	});
});

test("the --resume picker's delete of a valid id deletes the session and removes its blob directory (#4326)", async () => {
	const { agentDir, sentinel } = agentDirectoryWithSentinel();
	const store = new MemorySessionStore();
	const deletions = vi.spyOn(store, "delete");

	await deleteSessionFromPicker(store, agentDir, "stage-session");

	assert.deepEqual(deletions.mock.calls, [["stage-session"]]);
	assert.equal(existsSync(getReleasedStageBlobDir(agentDir, "stage-session")), false);
	assert.equal(existsSync(sentinel), true);
});

test("the blob directory a valid id names is a direct child of the blob root (#4309)", () => {
	for (const id of ["01a1abc7-438c-78cb-9174-1e13699bcd86", "a..b", "a.b_c-d"])
		assert.equal(relative("/agent/blobs/tool-output", getReleasedStageBlobDir("/agent", id)), id);
});
