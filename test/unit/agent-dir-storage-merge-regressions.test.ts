import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import {
	resetStorageHomeCacheForTests,
	storageHomeDir,
} from "../../packages/coding-agent/src/core/storage/file-identity.js";
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
	root = makeTempDirectory("agent-dir-storage-merge-");
});

afterEach(() => {
	vi.unstubAllEnvs();
	resetStorageHomeCacheForTests();
	removeTempDirectory(root);
});

test("a sibling profile whose settings hold only the removed modelRouting key keeps the legacy parent store from a new sibling (#5242)", () => {
	const parent = join(root, "routing-parent");
	const legacyProfile = join(parent, "old");
	const newProfile = join(parent, "new");
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	mkdirSync(legacyProfile, { recursive: true });
	writeFileSync(join(legacyProfile, "settings.json"), JSON.stringify({ modelRouting: { enabled: true } }));

	assert.equal(storageHomeDir(newProfile), newProfile);
});

test("selectSessionStorage without settings reads them to settle a relative process selection's storage home (#5242)", () => {
	const parent = join(root, "lazy-settings-parent");
	const agentDir = join(parent, "agent-a");
	const project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	vi.stubEnv("ATOMIC_SESSIONS_STORAGE", JSON.stringify({ path: "sessions.sqlite" }));

	const selection = selectSessionStorage(project, { agentDir });

	assert.deepEqual(selection, { kind: "sqlite", path: join(agentDir, "sessions.sqlite") });
	assert.equal(existsSync(join(agentDir, ".atomic-storage-home")), true);
});
