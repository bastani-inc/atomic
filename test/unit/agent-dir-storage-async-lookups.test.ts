import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	selectSessionStorage,
	selectSessionStorageWithSettingsAsync,
} from "../../packages/coding-agent/src/core/session-storage.js";
import {
	resetStorageHomeCacheForTests,
	storageHomeDirAsync,
} from "../../packages/coding-agent/src/core/storage/file-identity.js";
import { secretFilePath, secretFilePathAsync } from "../../packages/coding-agent/src/core/storage/provider.js";
import { selectRunJournal, selectRunJournalAsync } from "../../packages/workflows/src/durable/journal/resolution.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const STORAGE_ENV_KEYS = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
	"ATOMIC_PROFILE",
] as const;

let root: string;

beforeEach(() => {
	resetStorageHomeCacheForTests();
	for (const key of STORAGE_ENV_KEYS) vi.stubEnv(key, "");
	root = makeTempDirectory("agent-dir-storage-async-");
});

afterEach(() => {
	vi.unstubAllEnvs();
	resetStorageHomeCacheForTests();
	removeTempDirectory(root);
});

function legacyParent(name: string): { parent: string; agentDir: string } {
	const parent = join(root, name);
	const agentDir = join(parent, "agent-a");
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	mkdirSync(agentDir, { recursive: true });
	return { parent, agentDir };
}

test("overlapping lookups without blocking agree with the synchronous one on an adopted legacy parent (#5242)", async () => {
	const { parent, agentDir } = legacyParent("concurrent-parent");
	const settings = { workflows: { journal: { path: "journal-relative.sqlite" } } };

	const [first, second] = await Promise.all([
		storageHomeDirAsync(agentDir, settings),
		storageHomeDirAsync(agentDir, settings),
	]);
	assert.equal(first, parent);
	assert.equal(second, parent);

	const journal = await selectRunJournalAsync({ agentDir, settings });
	resetStorageHomeCacheForTests();
	assert.deepEqual(selectRunJournal({ agentDir, settings }), journal);
});

test("the asynchronous session, journal and secret lookups resolve what the synchronous ones do (#5242)", async () => {
	const { agentDir } = legacyParent("equivalence-parent");
	const project = join(root, "project");
	mkdirSync(project, { recursive: true });
	vi.stubEnv("ATOMIC_SESSIONS_STORAGE", JSON.stringify({ path: "sessions.sqlite" }));

	const asyncSession = await selectSessionStorageWithSettingsAsync(project, { agentDir, settings: {} });
	const asyncJournal = await selectRunJournalAsync({ agentDir, settings: {} });
	const asyncSecret = await secretFilePathAsync("storage-token.json", agentDir);
	resetStorageHomeCacheForTests();
	assert.deepEqual(selectSessionStorage(project, { agentDir, settings: {} }), asyncSession);
	assert.deepEqual(selectRunJournal({ agentDir, settings: {} }), asyncJournal);
	assert.equal(secretFilePath("storage-token.json", agentDir), asyncSecret);
});
