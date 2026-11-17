import assert from "node:assert/strict";
import { existsSync, mkdirSync, type PathLike, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

type FaultCode = "EPERM" | "EACCES" | "EROFS" | "EIO";

const fsFaults = vi.hoisted(() => ({
	readOnlyDirs: new Map<string, FaultCode>(),
	unreadableFiles: new Map<string, FaultCode>(),
	unreadableOpenDirs: new Map<string, FaultCode>(),
}));

function errnoException(code: FaultCode, syscall: string, path: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: ${syscall} '${path}'`), {
		code,
		syscall,
		path,
	});
}

function isSameOrInside(candidate: string, directory: string): boolean {
	const resolvedCandidate = resolve(candidate);
	const resolvedDirectory = resolve(directory);
	const rel = relative(resolvedDirectory, resolvedCandidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function matchingReadOnlyDir(target: PathLike | number): { dir: string; code: FaultCode } | undefined {
	if (typeof target !== "string") return undefined;
	for (const [dir, code] of fsFaults.readOnlyDirs) {
		if (isSameOrInside(target, dir)) return { dir, code };
	}
	return undefined;
}

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
			const match = matchingReadOnlyDir(args[0]);
			if (match !== undefined && (typeof args[0] !== "string" || !fs.existsSync(args[0]))) {
				throw errnoException(match.code, "mkdir", String(args[0]));
			}
			return fs.mkdirSync(...args);
		},
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			const match = matchingReadOnlyDir(args[0]);
			if (match !== undefined) throw errnoException(match.code, "open", String(args[0]));
			return fs.writeFileSync(...args);
		},
		linkSync: (...args: Parameters<typeof fs.linkSync>) => {
			const match = matchingReadOnlyDir(args[1]);
			if (match !== undefined) throw errnoException(match.code, "link", String(args[1]));
			return fs.linkSync(...args);
		},
		renameSync: (...args: Parameters<typeof fs.renameSync>) => {
			const match = matchingReadOnlyDir(args[0]) ?? matchingReadOnlyDir(args[1]);
			if (match !== undefined) throw errnoException(match.code, "rename", String(args[1]));
			return fs.renameSync(...args);
		},
		rmSync: (...args: Parameters<typeof fs.rmSync>) => {
			const match = matchingReadOnlyDir(args[0]);
			if (match !== undefined && (typeof args[0] !== "string" || fs.existsSync(args[0]))) {
				throw errnoException(match.code, "unlink", String(args[0]));
			}
			return fs.rmSync(...args);
		},
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			if (typeof args[0] === "string") {
				const code = fsFaults.unreadableFiles.get(resolve(args[0]));
				if (code !== undefined) throw errnoException(code, "open", args[0]);
			}
			return fs.readFileSync(...args);
		},
		opendirSync: (...args: Parameters<typeof fs.opendirSync>) => {
			if (typeof args[0] === "string") {
				const code = fsFaults.unreadableOpenDirs.get(resolve(args[0]));
				if (code !== undefined) throw errnoException(code, "opendir", args[0]);
			}
			return fs.opendirSync(...args);
		},
	};
});
vi.resetModules();

const {
	coLocatesWorkflowStore,
	defaultJournalStoreDirectory,
	defaultSessionDatabasePath,
	defaultSharedStoragePath,
	resetStorageHomeCacheForTests,
	storageHomeDir,
	storagePathBaseDir,
	takeStorageAdoptionNotice,
} = await import("../../packages/coding-agent/src/core/storage/file-identity.js");
const { resolveSessionStore, selectSessionStorage } = await import(
	"../../packages/coding-agent/src/core/session-storage.js"
);
const { collectStorageStatus, selectJournal } = await import(
	"../../packages/coding-agent/src/core/storage/storage-status.js"
);

let root: string;

beforeEach(() => {
	fsFaults.readOnlyDirs.clear();
	fsFaults.unreadableFiles.clear();
	fsFaults.unreadableOpenDirs.clear();
	root = makeTempDirectory("storage-read-only-");
	resetStorageHomeCacheForTests();
	for (const name of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
		"ATOMIC_PROFILE",
		"ATOMIC_CODING_AGENT_DIR",
		"PI_CODING_AGENT_DIR",
	])
		vi.stubEnv(name, "");
});

afterEach(() => {
	fsFaults.readOnlyDirs.clear();
	fsFaults.unreadableFiles.clear();
	fsFaults.unreadableOpenDirs.clear();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function useHome(home: string): void {
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	resetStorageHomeCacheForTests();
}

const PERMISSION_CODES: readonly ("EPERM" | "EACCES" | "EROFS")[] = ["EPERM", "EACCES", "EROFS"];

test.each(PERMISSION_CODES)(
	"a read-only (%s) default agent directory uses the writable current-HOME storage in selection, SDK resolveSessionStore, and storage status (#5242)",
	async (code) => {
		const home = join(root, `default-${code.toLowerCase()}`);
		const atomicHome = join(home, ".atomic");
		const agent = join(atomicHome, "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
		useHome(home);
		fsFaults.readOnlyDirs.set(agent, code);

		const expectedSessionDb = join(atomicHome, "workflows", "journal.sqlite");
		const expectedJournalDir = join(atomicHome, "workflows", "journal");
		const expectedSharedDb = join(atomicHome, "storage.sqlite");

		assert.equal(storageHomeDir(agent, {}), atomicHome);
		assert.equal(defaultSessionDatabasePath(agent, {}), expectedSessionDb);
		assert.equal(defaultJournalStoreDirectory(agent, {}), expectedJournalDir);
		assert.equal(defaultSharedStoragePath(agent, {}), expectedSharedDb);
		assert.equal(coLocatesWorkflowStore(agent, {}), false);
		assert.equal(
			storagePathBaseDir("team.sqlite", agent, { sessions: { storage: { path: "team.sqlite" } } }),
			atomicHome,
		);
		assert.deepEqual(selectSessionStorage(root, { agentDir: agent, settings: {} }), {
			kind: "sqlite",
			path: expectedSessionDb,
		});
		assert.deepEqual(
			selectSessionStorage(root, {
				agentDir: agent,
				settings: { sessions: { storage: { path: "team.sqlite" } } },
			}),
			{
				kind: "sqlite",
				path: join(atomicHome, "team.sqlite"),
			},
		);
		assert.deepEqual(selectJournal(agent, {}), {
			kind: "sharded",
			dir: expectedJournalDir,
		});

		resetStorageHomeCacheForTests();
		const store = await resolveSessionStore(root, { agentDir: agent });
		try {
			assert.equal(store.descriptor.location, expectedSessionDb);
		} finally {
			await store.close();
		}

		resetStorageHomeCacheForTests();
		const status = await collectStorageStatus({ cwd: root, agentDir: agent, probe: true });
		for (const domain of status.domains) {
			assert.equal(domain.error, undefined, `unexpected ${domain.domain} error: ${domain.error}`);
		}
		const sessionsDomain = status.domains.find((domain) => domain.domain === "sessions");
		const journalDomain = status.domains.find((domain) => domain.domain === "journal");
		assert.equal(sessionsDomain?.selection, `SQLite ${expectedSessionDb}`);
		assert.equal(sessionsDomain?.probe?.connection.status, "ok");
		assert.equal(journalDomain?.selection, `journal store ${expectedJournalDir}`);
		assert.equal(existsSync(join(agent, ".atomic-storage-home")), false);
	},
);

test.each(PERMISSION_CODES)(
	"a read-only (%s) custom agent directory adopts its writable parent store and isolates siblings across selection, SDK resolveSessionStore, and storage status (#5242)",
	async (code) => {
		const home = join(root, `custom-home-${code.toLowerCase()}`);
		useHome(home);
		const parent = join(root, `custom-parent-${code.toLowerCase()}`);
		const agent = join(parent, "agent");
		const sibling = join(parent, "sibling");
		mkdirSync(agent, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		mkdirSync(join(parent, "workflows"), { recursive: true });
		const legacyDb = join(parent, "workflows", "journal.sqlite");
		const legacyJournalDir = join(parent, "workflows", "journal");
		const legacyRelative = join(parent, "history.sqlite");
		writeFileSync(legacyDb, "");
		writeFileSync(legacyRelative, "history");
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "medium" }));

		fsFaults.readOnlyDirs.set(agent, code);

		assert.equal(storageHomeDir(agent, {}), parent);
		assert.equal(defaultSessionDatabasePath(agent, {}), legacyDb);
		assert.equal(defaultJournalStoreDirectory(agent, {}), legacyJournalDir);
		assert.equal(defaultSharedStoragePath(agent, {}), join(parent, "storage.sqlite"));
		assert.equal(coLocatesWorkflowStore(agent, {}), false);
		assert.deepEqual(selectSessionStorage(root, { agentDir: agent, settings: {} }), {
			kind: "sqlite",
			path: legacyDb,
		});
		assert.deepEqual(
			selectSessionStorage(root, {
				agentDir: agent,
				settings: { sessions: { storage: { path: "history.sqlite" } } },
			}),
			{
				kind: "sqlite",
				path: legacyRelative,
			},
		);
		assert.deepEqual(
			selectSessionStorage(root, {
				agentDir: sibling,
				settings: { sessions: { storage: { path: "history.sqlite" } } },
			}),
			{
				kind: "sqlite",
				path: join(sibling, "history.sqlite"),
			},
		);

		const notice = takeStorageAdoptionNotice(agent, {});
		assert.match(notice ?? "", /Adopted existing storage/);
		assert.equal(takeStorageAdoptionNotice(agent, {}), undefined);

		resetStorageHomeCacheForTests();
		const store = await resolveSessionStore(root, { agentDir: agent });
		try {
			assert.equal(store.descriptor.location, legacyDb);
		} finally {
			await store.close();
		}

		resetStorageHomeCacheForTests();
		const status = await collectStorageStatus({ cwd: root, agentDir: agent, probe: true });
		for (const domain of status.domains) {
			assert.equal(domain.error, undefined, `unexpected ${domain.domain} error: ${domain.error}`);
		}
		assert.equal(status.domains.find((domain) => domain.domain === "sessions")?.selection, `SQLite ${legacyDb}`);
		assert.equal(
			status.domains.find((domain) => domain.domain === "journal")?.selection,
			`journal store ${legacyJournalDir}`,
		);

		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(sibling, {}), sibling);
		assert.equal(storageHomeDir(agent, {}), parent);
		assert.equal(existsSync(join(agent, ".atomic-storage-home")), false);
	},
);

test("unreadable or malformed existing storage home and target decision files still fail closed even when the agent directory is read-only (#5242)", async () => {
	const home = join(root, "fail-closed-home");
	useHome(home);

	const unreadableDefaultAgent = join(home, ".atomic", "agent");
	mkdirSync(unreadableDefaultAgent, { recursive: true });
	const defaultDecisionFile = join(unreadableDefaultAgent, ".atomic-storage-home");
	writeFileSync(
		defaultDecisionFile,
		`${JSON.stringify({ home: dirname(unreadableDefaultAgent), defaultHome: true })}\n`,
	);
	fsFaults.readOnlyDirs.set(unreadableDefaultAgent, "EACCES");
	fsFaults.unreadableFiles.set(resolve(defaultDecisionFile), "EACCES");

	assert.throws(() => storageHomeDir(unreadableDefaultAgent, {}), /Cannot read storage home decision/);
	await assert.rejects(
		resolveSessionStore(root, { agentDir: unreadableDefaultAgent }),
		/Cannot read storage home decision/,
	);
	const unreadableStatus = await collectStorageStatus({
		cwd: root,
		agentDir: unreadableDefaultAgent,
		probe: false,
	});
	assert.equal(unreadableStatus.domains.find((domain) => domain.domain === "sessions")?.selection, "invalid");
	assert.match(
		unreadableStatus.domains.find((domain) => domain.domain === "sessions")?.error ?? "",
		/Cannot read storage home decision/,
	);

	for (const [index, contents] of [
		"{not-valid-json\n",
		`${JSON.stringify({ home: "relative/home" })}\n`,
		`${JSON.stringify({ home: join(root, "other"), defaultHome: "invalid" })}\n`,
	].entries()) {
		const parent = join(root, `malformed-parent-${index}`);
		const agent = join(parent, "agent");
		mkdirSync(agent, { recursive: true });
		mkdirSync(join(parent, "workflows"), { recursive: true });
		writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
		writeFileSync(join(agent, ".atomic-storage-home"), contents);
		fsFaults.readOnlyDirs.set(agent, "EROFS");
		resetStorageHomeCacheForTests();

		assert.throws(
			() => storageHomeDir(agent, {}),
			/Invalid storage home decision|Unexpected token|Expected property name|JSON/,
		);
		await assert.rejects(
			resolveSessionStore(root, { agentDir: agent }),
			/Invalid storage home decision|Unexpected token|Expected property name|JSON/,
		);
		const malformedStatus = await collectStorageStatus({ cwd: root, agentDir: agent, probe: false });
		assert.equal(malformedStatus.domains.find((domain) => domain.domain === "sessions")?.selection, "invalid");
	}

	const targetParent = join(root, "target-decision-parent");
	const targetAgent = join(targetParent, "agent");
	mkdirSync(targetAgent, { recursive: true });
	const settings = { sessions: { storage: { path: "team.sqlite" } } };
	assert.equal(storagePathBaseDir("team.sqlite", targetAgent, settings), targetAgent);
	const targetDecisionFile = join(
		targetAgent,
		(await import("node:fs"))
			.readdirSync(targetAgent)
			.find((entry) => entry.startsWith(".atomic-storage-home.target-"))!,
	);
	writeFileSync(targetDecisionFile, `${JSON.stringify({ home: "not-absolute" })}\n`);
	fsFaults.readOnlyDirs.set(targetAgent, "EPERM");
	resetStorageHomeCacheForTests();
	assert.throws(() => storagePathBaseDir("team.sqlite", targetAgent, settings), /Invalid storage home decision/);

	const ioFailureAgent = join(root, "io-failure-parent", "agent");
	mkdirSync(ioFailureAgent, { recursive: true });
	fsFaults.readOnlyDirs.set(ioFailureAgent, "EIO");
	resetStorageHomeCacheForTests();
	assert.throws(() => storageHomeDir(ioFailureAgent, {}), /Cannot settle storage decision/);
});

test("an EACCES opendirSync failure while scanning for a missing or moved owner identity keeps a sibling on its own store without crashing or taking parent ownership (#5242)", () => {
	const home = join(root, "scan-home");
	useHome(home);
	const parent = join(root, "scan-parent");
	const owner = join(parent, "owner");
	const movedOwner = join(root, "moved-owner");
	const sibling = join(parent, "sibling");
	mkdirSync(owner, { recursive: true });
	mkdirSync(sibling, { recursive: true });
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "");
	writeFileSync(join(parent, "team.sqlite"), "history");

	const settings = { sessions: { storage: { path: "team.sqlite" } } };
	assert.equal(storageHomeDir(owner, settings), parent);
	assert.deepEqual(selectSessionStorage(root, { agentDir: owner, settings }), {
		kind: "sqlite",
		path: join(parent, "team.sqlite"),
	});

	symlinkSync(owner, movedOwner, "junction");
	rmSync(owner, { recursive: true, force: true });
	resetStorageHomeCacheForTests();
	fsFaults.unreadableOpenDirs.set(resolve(parent), "EACCES");

	assert.equal(storageHomeDir(sibling, {}), sibling);
	assert.deepEqual(selectSessionStorage(root, { agentDir: sibling, settings: {} }), {
		kind: "sqlite",
		path: join(sibling, "workflows", "journal.sqlite"),
	});
	assert.deepEqual(selectSessionStorage(root, { agentDir: sibling, settings }), {
		kind: "sqlite",
		path: join(sibling, "team.sqlite"),
	});
});
