import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const filesystemWork = vi.hoisted(() => ({
	reads: 0,
	writes: 0,
	directoryOpens: 0,
	transientReadPath: undefined as string | undefined,
}));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			filesystemWork.reads++;
			if (args[0] === filesystemWork.transientReadPath) {
				filesystemWork.transientReadPath = undefined;
				throw Object.assign(new Error("Transient configuration read failure"), { code: "EIO" });
			}
			return fs.readFileSync(...args);
		},
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			filesystemWork.writes++;
			return fs.writeFileSync(...args);
		},
		opendirSync: (...args: Parameters<typeof fs.opendirSync>) => {
			filesystemWork.directoryOpens++;
			return fs.opendirSync(...args);
		},
	};
});
vi.resetModules();
const { coLocatesWorkflowStore, resetStorageHomeCacheForTests, storagePathBaseDir } = await import(
	"../../packages/coding-agent/src/core/storage/file-identity.js"
);

let root: string;
beforeEach(() => {
	root = makeTempDirectory("storage-lookups-");
	resetStorageHomeCacheForTests();
	filesystemWork.transientReadPath = undefined;
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

function resetFilesystemWork(): void {
	filesystemWork.reads = 0;
	filesystemWork.writes = 0;
	filesystemWork.directoryOpens = 0;
}

test("repeated relative selections reuse a settled local target without rereading its decision (#5242)", () => {
	const agent = join(root, "agent");
	mkdirSync(agent);
	const settings = { sessions: { storage: { path: "history.sqlite" } } };
	assert.equal(storagePathBaseDir("history.sqlite", agent, settings), agent);
	resetFilesystemWork();
	for (let index = 0; index < 3; index++) {
		assert.equal(storagePathBaseDir("history.sqlite", agent, settings), agent);
	}
	assert.equal(filesystemWork.reads, 0);
	assert.equal(filesystemWork.writes, 0);
});

test("unsettled workflow resource discovery reuses unchanged prior-use scans without settling storage (#5242)", () => {
	const agent = join(root, "fresh");
	mkdirSync(agent);
	mkdirSync(join(root, "original", "extensions"), { recursive: true });
	mkdirSync(join(root, "workflows"));
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	for (let index = 0; index < 20; index++) mkdirSync(join(root, `directory-${index}`));
	assert.equal(coLocatesWorkflowStore(agent, {}), true);
	resetFilesystemWork();
	assert.equal(coLocatesWorkflowStore(agent, {}), true);
	assert.ok(filesystemWork.directoryOpens <= 1, `${filesystemWork.directoryOpens} directories reopened`);
	assert.equal(filesystemWork.writes, 0);
	mkdirSync(join(root, "original", "workflows"));
	writeFileSync(join(root, "original", "workflows", "journal.sqlite"), "");
	assert.equal(coLocatesWorkflowStore(agent, {}), false);
});

test("workflow discovery notices existing configuration edits and new state after a cached prior-use scan (#5242)", () => {
	const agent = join(root, "fresh");
	const original = join(root, "original");
	mkdirSync(agent);
	mkdirSync(original);
	mkdirSync(join(root, "workflows"));
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	writeFileSync(join(original, "settings.json"), JSON.stringify({ theme: "dark" }));
	assert.equal(coLocatesWorkflowStore(agent, {}), false);
	writeFileSync(join(original, "settings.json"), JSON.stringify({ defaultModel: "configured" }));
	assert.equal(coLocatesWorkflowStore(agent, {}), true);
	writeFileSync(join(original, "settings.json"), JSON.stringify({ theme: "light" }));
	assert.equal(coLocatesWorkflowStore(agent, {}), false);
	mkdirSync(join(original, "skills"));
	assert.equal(coLocatesWorkflowStore(agent, {}), true);
});

test("a transient configuration read failure cannot cache away an established profile's adoption priority (#5242)", () => {
	const agent = join(root, "fresh");
	const original = join(root, "original");
	mkdirSync(agent);
	mkdirSync(original);
	mkdirSync(join(root, "workflows"));
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	const settingsPath = join(original, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ defaultModel: "configured" }));
	filesystemWork.transientReadPath = settingsPath;
	assert.equal(coLocatesWorkflowStore(agent, {}), false);
	assert.equal(coLocatesWorkflowStore(agent, {}), true);
	assert.equal(storagePathBaseDir("local.sqlite", agent, {}), agent);
});

test("repeated external relative selections check their owner without publishing another claim (#5242)", () => {
	const agent = join(root, "agent");
	mkdirSync(agent);
	writeFileSync(join(root, "history.sqlite"), "history");
	const settings = { sessions: { storage: { path: "history.sqlite" } } };
	assert.equal(storagePathBaseDir("history.sqlite", agent, settings), root);
	resetFilesystemWork();
	for (let index = 0; index < 3; index++) {
		assert.equal(storagePathBaseDir("history.sqlite", agent, settings), root);
	}
	assert.equal(filesystemWork.writes, 0);
});
