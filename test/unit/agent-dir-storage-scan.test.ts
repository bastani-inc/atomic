import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		opendirSync: (...args: Parameters<typeof fs.opendirSync>) => {
			const directory = fs.opendirSync(...args);
			const entries: import("node:fs").Dirent[] = [];
			for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) entries.push(entry);
			entries.sort((left, right) => left.name.localeCompare(right.name));
			directory.readSync = () => entries.shift() ?? null;
			return directory;
		},
	};
});
vi.resetModules();
const { resetStorageHomeCacheForTests, storageHomeDir } = await import(
	"../../packages/coding-agent/src/core/storage/file-identity.js"
);

let root: string;
beforeEach(() => {
	root = makeTempDirectory("storage-scan-");
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

const LARGE_PROFILE_ENTRY_COUNT = 300;

test("a large agent directory keeps its legacy history ahead of an empty sibling regardless of entry order (#5242)", () => {
	const original = join(root, "original");
	const fresh = join(root, "fresh");
	mkdirSync(original);
	mkdirSync(fresh);
	mkdirSync(join(root, "workflows"));
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	for (let index = 0; index < LARGE_PROFILE_ENTRY_COUNT; index++) {
		writeFileSync(join(original, `entry-${index}`), "");
	}
	mkdirSync(join(original, "skills"));

	assert.equal(storageHomeDir(fresh, {}), fresh);
	assert.equal(storageHomeDir(original, {}), root);
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(original, {}), root);
});

const LARGE_PARENT_ENTRY_COUNT = 1_100;

test("an established profile beyond many ordinary sibling directories keeps its legacy history (#5242)", () => {
	const original = join(root, "original");
	const fresh = join(root, "fresh");
	mkdirSync(join(original, "extensions"), { recursive: true });
	mkdirSync(fresh);
	mkdirSync(join(root, "workflows"));
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	for (let index = 0; index < LARGE_PARENT_ENTRY_COUNT; index++) {
		mkdirSync(join(root, `directory-${index}`));
	}

	assert.equal(storageHomeDir(fresh, {}), fresh);
	assert.equal(storageHomeDir(original, {}), root);
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(original, {}), root);
});
