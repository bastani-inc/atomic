import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test, vi } from "vitest";
import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import { resetStorageHomeCacheForTests } from "../../packages/coding-agent/src/core/storage/file-identity.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { storageWriteLocksFree } from "../helpers/workflow-subscription-chaos.js";

let root: string;
beforeEach(() => {
	root = makeTempDirectory("subscription-storage-locks-");
	resetStorageHomeCacheForTests();
	for (const name of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
		"ATOMIC_PROFILE",
	])
		vi.stubEnv(name, "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

test("SIGSTOP safety checks include the isolated event children's actual session database (#4311, #5242)", async () => {
	const selection = selectSessionStorage(root, { agentDir: join(root, "agent"), settings: {} });
	assert.ok("kind" in selection && selection.kind === "sqlite");
	mkdirSync(dirname(selection.path), { recursive: true });
	const database = new DatabaseSync(selection.path);
	try {
		database.exec("CREATE TABLE fixture (value INTEGER)");
		assert.equal(await storageWriteLocksFree(root), true);
		database.exec("BEGIN IMMEDIATE");
		try {
			assert.equal(await storageWriteLocksFree(root), false);
		} finally {
			database.exec("ROLLBACK");
		}
		assert.equal(await storageWriteLocksFree(root), true);
	} finally {
		database.close();
	}
});
