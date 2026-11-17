import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const reads = vi.hoisted(() => ({ before: undefined as ((path: string) => void) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const readFile = ((...args: Parameters<typeof actual.readFile>) => {
		reads.before?.(String(args[0]));
		return actual.readFile(...args);
	}) as typeof actual.readFile;
	return { ...actual, readFile, default: { ...actual, readFile } };
});

vi.resetModules();
const { resetStorageHomeCacheForTests, storageHomeDir, storageHomeDirAsync, takeStorageAdoptionNotice } = await import(
	"../../packages/coding-agent/src/core/storage/file-identity.js"
);

let root: string;

beforeEach(() => {
	resetStorageHomeCacheForTests();
	for (const key of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
		"ATOMIC_PROFILE",
	])
		vi.stubEnv(key, "");
	root = makeTempDirectory("agent-dir-storage-overlap-");
});

afterEach(() => {
	reads.before = undefined;
	vi.unstubAllEnvs();
	resetStorageHomeCacheForTests();
	removeTempDirectory(root);
});

test("a storage home lookup without settings that overlaps the settled adoption does not discard it (#5242)", async () => {
	const parent = join(root, "overlap-parent");
	const agentDir = join(parent, "agent-a");
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "{}");
	let settled: string | undefined;
	reads.before = (path) => {
		if (path !== join(agentDir, "settings.json")) return;
		reads.before = undefined;
		settled = storageHomeDir(agentDir, {});
	};

	const provisional = await storageHomeDirAsync(agentDir);

	assert.equal(settled, parent);
	assert.equal(provisional, parent);
	assert.match(takeStorageAdoptionNotice(agentDir) ?? "", /^Adopted existing storage at /);
});
