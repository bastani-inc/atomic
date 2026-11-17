import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const filesystemWork = vi.hoisted(() => ({
	reads: 0,
	readPaths: [] as string[],
	writes: 0,
	directoryOpens: 0,
	bulkDirectoryReads: 0,
	transientReadPath: undefined as string | undefined,
	fixedVersionDirectory: undefined as string | undefined,
	fixedVersionFile: undefined as string | undefined,
}));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
			filesystemWork.bulkDirectoryReads++;
			return fs.readdirSync(...args);
		},
		statSync: (...args: Parameters<typeof fs.statSync>) => {
			const stat = fs.statSync(...args);
			if (args[0] === filesystemWork.fixedVersionDirectory || args[0] === filesystemWork.fixedVersionFile) {
				Object.defineProperties(stat, { mtimeNs: { value: 0n }, ctimeNs: { value: 0n } });
				if (args[0] === filesystemWork.fixedVersionDirectory) Object.defineProperty(stat, "size", { value: 0n });
			}
			return stat;
		},
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			filesystemWork.reads++;
			if (typeof args[0] === "string") filesystemWork.readPaths.push(args[0]);
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
const { coLocatesWorkflowStore, readClaimFile, resetStorageHomeCacheForTests, storagePathBaseDir } = await import(
	"../../packages/coding-agent/src/core/storage/file-identity.js"
);

let root: string;
beforeEach(() => {
	root = makeTempDirectory("storage-lookups-");
	resetStorageHomeCacheForTests();
	filesystemWork.transientReadPath = undefined;
	filesystemWork.fixedVersionDirectory = undefined;
	filesystemWork.fixedVersionFile = undefined;
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
	filesystemWork.readPaths.length = 0;
	filesystemWork.writes = 0;
	filesystemWork.directoryOpens = 0;
	filesystemWork.bulkDirectoryReads = 0;
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

test("missing storage claims avoid exception-driven reads without hiding later publication (#5242)", () => {
	const claim = join(root, "claim");
	resetFilesystemWork();
	assert.equal(readClaimFile(claim), undefined);
	assert.equal(filesystemWork.reads, 0);
	writeFileSync(claim, "owner\n");
	assert.equal(readClaimFile(claim), "owner");
});

test.each(["missing", "existing"])(
	"repeated default relative selections reuse owned %s targets without rereading claims (#5242)",
	(state) => {
		const home = join(root, "home");
		const agent = join(home, ".atomic", "agent");
		mkdirSync(agent, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		if (state === "existing") writeFileSync(join(home, ".atomic", "history.sqlite"), "history");
		const settings = { sessions: { storage: { path: "history.sqlite" } } };
		assert.equal(storagePathBaseDir("history.sqlite", agent, settings), join(home, ".atomic"));
		resetFilesystemWork();
		for (let index = 0; index < 3; index++)
			assert.equal(storagePathBaseDir("history.sqlite", agent, settings), join(home, ".atomic"));
		assert.equal(filesystemWork.reads, 0);
		assert.equal(filesystemWork.writes, 0);
	},
);

test("unsettled workflow resource discovery uses bulk profile reads without settling storage (#5242)", () => {
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
	assert.ok(filesystemWork.bulkDirectoryReads > 0);
	assert.equal(filesystemWork.writes, 0);
	mkdirSync(join(root, "original", "workflows"));
	writeFileSync(join(root, "original", "workflows", "journal.sqlite"), "");
	assert.equal(coLocatesWorkflowStore(agent, {}), false);
});

test("workflow discovery notices configuration and entry changes even when filesystem timestamps do not change (#5242)", () => {
	const agent = join(root, "fresh");
	const original = join(root, "original");
	mkdirSync(agent);
	mkdirSync(original);
	mkdirSync(join(root, "workflows"));
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	const settingsPath = join(original, "settings.json");
	filesystemWork.fixedVersionDirectory = original;
	filesystemWork.fixedVersionFile = settingsPath;
	writeFileSync(settingsPath, JSON.stringify({ ignoredModel: "configured" }));
	assert.equal(coLocatesWorkflowStore(agent, {}), false);
	writeFileSync(settingsPath, JSON.stringify({ defaultModel: "configured" }));
	assert.equal(coLocatesWorkflowStore(agent, {}), true);
	writeFileSync(settingsPath, JSON.stringify({ ignoredModel: "configured" }));
	assert.equal(coLocatesWorkflowStore(agent, {}), false);
	mkdirSync(join(original, "skills"));
	assert.equal(coLocatesWorkflowStore(agent, {}), true);
});

test("unchanged prior-use configuration is read fresh without reparsing (#5242)", () => {
	const agent = join(root, "fresh");
	mkdirSync(agent);
	mkdirSync(join(root, "original"));
	mkdirSync(join(root, "workflows"));
	writeFileSync(join(root, "workflows", "journal.sqlite"), "");
	const settingsPath = join(root, "original", "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ ignoredModel: "configured" }));
	const parse = vi.spyOn(JSON, "parse");
	try {
		assert.equal(coLocatesWorkflowStore(agent, {}), false);
		assert.ok(parse.mock.calls.length > 0);
		parse.mockClear();
		resetFilesystemWork();
		assert.equal(coLocatesWorkflowStore(agent, {}), false);
		assert.equal(parse.mock.calls.length, 0);
		assert.ok(filesystemWork.bulkDirectoryReads > 0);
		assert.ok(filesystemWork.readPaths.includes(settingsPath));
	} finally {
		parse.mockRestore();
	}
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
