import assert from "node:assert/strict";
import {
	cpSync,
	existsSync,
	mkdirSync,
	type PathLike,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { renameSyncWithRetry } from "../helpers/rename-retry.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

type FaultCode = "EPERM" | "EACCES" | "EROFS" | "EIO";

interface StatIdentityOverride {
	readonly dev?: bigint;
	readonly ino?: bigint;
	readonly birthtimeNs?: bigint;
}

const fsFaults = vi.hoisted(() => ({
	readOnlyDirs: new Map<string, FaultCode>(),
	renameTargets: new Map<string, FaultCode>(),
	unreadableFiles: new Map<string, FaultCode>(),
	unreadableOpenDirs: new Map<string, FaultCode>(),
	statOverrides: new Map<string, StatIdentityOverride>(),
	globalZeroIno: false,
	recordedReads: [] as string[],
	recordedWriteAttempts: [] as string[],
}));

function applyStatOverride<T extends object | undefined>(path: PathLike, stats: T): T {
	if (stats === undefined || typeof path !== "string") return stats;
	const override = fsFaults.statOverrides.get(resolve(path));
	if (override === undefined && !fsFaults.globalZeroIno) return stats;
	const isBigInt = typeof (stats as { ino?: unknown }).ino === "bigint";
	const descriptors: PropertyDescriptorMap = {};
	if (override?.dev !== undefined) {
		descriptors.dev = { value: isBigInt ? override.dev : Number(override.dev), configurable: true };
	}
	if (override?.ino !== undefined) {
		descriptors.ino = { value: isBigInt ? override.ino : Number(override.ino), configurable: true };
	} else if (fsFaults.globalZeroIno) {
		descriptors.ino = { value: isBigInt ? 0n : 0, configurable: true };
	}
	if (override?.birthtimeNs !== undefined && isBigInt) {
		descriptors.birthtimeNs = { value: override.birthtimeNs, configurable: true };
	}
	return Object.defineProperties(stats, descriptors);
}

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
			if (typeof args[0] === "string") fsFaults.recordedWriteAttempts.push(resolve(args[0]));
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
			if (typeof args[1] === "string") {
				const code = fsFaults.renameTargets.get(resolve(args[1]));
				if (code !== undefined) throw errnoException(code, "rename", args[1]);
			}
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
				fsFaults.recordedReads.push(resolve(args[0]));
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
		statSync: ((...args: Parameters<typeof fs.statSync>) =>
			applyStatOverride(args[0], fs.statSync(...args))) as typeof fs.statSync,
	};
});
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const { existsSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
	const faulted = {
		mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
			const match = matchingReadOnlyDir(args[0]);
			if (match !== undefined && (typeof args[0] !== "string" || !existsSync(args[0]))) {
				throw errnoException(match.code, "mkdir", String(args[0]));
			}
			return fs.mkdir(...args);
		},
		writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
			const match = matchingReadOnlyDir(args[0] as PathLike);
			if (match !== undefined) throw errnoException(match.code, "open", String(args[0]));
			return fs.writeFile(...args);
		},
		link: async (...args: Parameters<typeof fs.link>) => {
			const match = matchingReadOnlyDir(args[1]);
			if (match !== undefined) throw errnoException(match.code, "link", String(args[1]));
			return fs.link(...args);
		},
		rename: async (...args: Parameters<typeof fs.rename>) => {
			if (typeof args[1] === "string") {
				const code = fsFaults.renameTargets.get(resolve(args[1]));
				if (code !== undefined) throw errnoException(code, "rename", args[1]);
			}
			const match = matchingReadOnlyDir(args[0]) ?? matchingReadOnlyDir(args[1]);
			if (match !== undefined) throw errnoException(match.code, "rename", String(args[1]));
			return fs.rename(...args);
		},
		rm: async (...args: Parameters<typeof fs.rm>) => {
			const match = matchingReadOnlyDir(args[0]);
			if (match !== undefined && (typeof args[0] !== "string" || existsSync(args[0]))) {
				throw errnoException(match.code, "unlink", String(args[0]));
			}
			return fs.rm(...args);
		},
		readFile: (async (...args: Parameters<typeof fs.readFile>) => {
			if (typeof args[0] === "string") {
				const code = fsFaults.unreadableFiles.get(resolve(args[0]));
				if (code !== undefined) throw errnoException(code, "open", args[0]);
			}
			return fs.readFile(...args);
		}) as typeof fs.readFile,
		opendir: async (...args: Parameters<typeof fs.opendir>) => {
			if (typeof args[0] === "string") {
				const code = fsFaults.unreadableOpenDirs.get(resolve(args[0]));
				if (code !== undefined) throw errnoException(code, "opendir", args[0]);
			}
			return fs.opendir(...args);
		},
		stat: (async (...args: Parameters<typeof fs.stat>) =>
			applyStatOverride(args[0], await fs.stat(...args))) as typeof fs.stat,
	};
	return { ...fs, ...faulted, default: { ...fs, ...faulted } };
});
vi.resetModules();

const {
	coLocatesWorkflowStore,
	defaultSessionDatabasePath,
	defaultSharedStoragePath,
	resetStorageHomeCacheForTests,
	storageHomeDir,
	storagePathBaseDir,
	takeStorageAdoptionNotice,
	workflowsStorageDir,
} = await import("../../packages/coding-agent/src/core/storage/file-identity.js");
const { resolveSessionStore, selectSessionStorage } = await import(
	"../../packages/coding-agent/src/core/session-storage.js"
);
const { collectStorageStatus } = await import("../../packages/coding-agent/src/core/storage/storage-status.js");

const { sweepReleasedHistory } = await import(
	"../../packages/coding-agent/src/core/storage/session/released-history-files.js"
);

/** Windows PowerShell's first start on a loaded machine: the time to look up the host's identity once. */
const HOST_IDENTITY_TIMEOUT_MS = 60_000;

// Opening a session store sweeps released history in the background, and the sweep's first run looks up the host's
// identity once per process, on Windows with a PowerShell child that inherits the environment. Under a test's stubbed
// USERPROFILE that child writes its profile folders (AppData\Roaming) into the test's directory, after the test has
// ended and while its directory is being removed (#5242). The lookup runs here once, under the real environment.
beforeAll(async () => {
	const directory = makeTempDirectory("storage-read-only-host-");
	try {
		await sweepReleasedHistory(join(directory, "agent"));
	} finally {
		removeTempDirectory(directory);
	}
}, HOST_IDENTITY_TIMEOUT_MS);

let root: string;

beforeEach(() => {
	fsFaults.readOnlyDirs.clear();
	fsFaults.renameTargets.clear();
	fsFaults.unreadableFiles.clear();
	fsFaults.unreadableOpenDirs.clear();
	fsFaults.statOverrides.clear();
	fsFaults.globalZeroIno = false;
	fsFaults.recordedReads.length = 0;
	fsFaults.recordedWriteAttempts.length = 0;
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
	fsFaults.renameTargets.clear();
	fsFaults.unreadableFiles.clear();
	fsFaults.unreadableOpenDirs.clear();
	fsFaults.statOverrides.clear();
	fsFaults.globalZeroIno = false;
	fsFaults.recordedReads.length = 0;
	fsFaults.recordedWriteAttempts.length = 0;
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
		const expectedSharedDb = join(atomicHome, "storage.sqlite");

		assert.equal(storageHomeDir(agent, {}), atomicHome);
		assert.equal(defaultSessionDatabasePath(agent, {}), expectedSessionDb);
		assert.equal(workflowsStorageDir(agent, {}), join(atomicHome, "workflows"));
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
		assert.equal(sessionsDomain?.selection, `SQLite ${expectedSessionDb}`);
		assert.equal(sessionsDomain?.probe?.connection.status, "ok");
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
		const legacyRelative = join(parent, "history.sqlite");
		writeFileSync(legacyDb, "");
		writeFileSync(legacyRelative, "history");
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "medium" }));

		fsFaults.readOnlyDirs.set(agent, code);

		assert.equal(storageHomeDir(agent, {}), parent);
		assert.equal(defaultSessionDatabasePath(agent, {}), legacyDb);
		assert.equal(workflowsStorageDir(agent, {}), join(parent, "workflows"));
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

const REFRESH_FAULT_CODES: readonly FaultCode[] = ["EPERM", "EACCES", "EROFS", "EIO"];

test.each(REFRESH_FAULT_CODES)(
	"a moved and renamed owner keeps its parent store and preserves an intact parent claim when owner refresh fails with %s on staged write or rename (#5242)",
	async (code) => {
		const home = join(root, `refresh-fault-home-${code.toLowerCase()}`);
		useHome(home);
		const original = join(root, `refresh-fault-parent-${code.toLowerCase()}`);
		const moved = join(root, `refresh-fault-moved-${code.toLowerCase()}`);
		const agent = join(original, "a1");
		const sibling = join(original, "sibling");
		mkdirSync(agent, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "medium" }));

		const sessionId = "66666666-6666-4666-8666-666666666666";
		const initialStore = await resolveSessionStore(root, {
			agentDir: agent,
			sessionStore: { kind: "sqlite", path: join(original, "workflows", "journal.sqlite") },
		});
		await initialStore.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: root }, []);
		await initialStore.close();

		assert.equal(storageHomeDir(agent, {}), original);
		assert.equal(storageHomeDir(sibling, {}), sibling);
		assert.equal(defaultSessionDatabasePath(agent, {}), join(original, "workflows", "journal.sqlite"));

		cpSync(original, moved, { recursive: true });
		rmSync(original, { recursive: true });
		const current = join(moved, "main");
		const movedSibling = join(moved, "sibling");
		renameSyncWithRetry(join(moved, "a1"), current);

		const claimFile = join(moved, ".atomic-storage-parent-owner");
		const claimBeforeRefresh = readFileSync(claimFile, "utf8");
		assert.equal(JSON.parse(claimBeforeRefresh).relativePath, "a1");

		fsFaults.readOnlyDirs.set(moved, code);
		resetStorageHomeCacheForTests();

		const expectedSessionDb = join(moved, "workflows", "journal.sqlite");
		assert.equal(storageHomeDir(current, {}), moved);
		assert.equal(defaultSessionDatabasePath(current, {}), expectedSessionDb);
		assert.equal(workflowsStorageDir(current, {}), join(moved, "workflows"));
		assert.deepEqual(selectSessionStorage(root, { agentDir: current, settings: {} }), {
			kind: "sqlite",
			path: expectedSessionDb,
		});
		assert.equal(readFileSync(claimFile, "utf8"), claimBeforeRefresh);
		assert.deepEqual(
			readdirSync(moved).filter((entry) => entry.endsWith(".tmp")),
			[],
		);
		assert.equal(storageHomeDir(movedSibling, {}), movedSibling);

		fsFaults.readOnlyDirs.clear();
		fsFaults.renameTargets.set(resolve(claimFile), code);
		resetStorageHomeCacheForTests();

		assert.equal(storageHomeDir(current, {}), moved);
		assert.equal(defaultSessionDatabasePath(current, {}), expectedSessionDb);
		assert.equal(readFileSync(claimFile, "utf8"), claimBeforeRefresh);
		assert.deepEqual(
			readdirSync(moved).filter((entry) => entry.endsWith(".tmp")),
			[],
		);

		resetStorageHomeCacheForTests();
		const restoredStore = await resolveSessionStore(root, { agentDir: current, settings: {} });
		try {
			assert.equal(restoredStore.descriptor.location, expectedSessionDb);
			assert.equal((await restoredStore.readHeader(sessionId))?.id, sessionId);
		} finally {
			await restoredStore.close();
		}

		resetStorageHomeCacheForTests();
		const status = await collectStorageStatus({ cwd: root, agentDir: current, probe: true });
		for (const domain of status.domains) {
			assert.equal(domain.error, undefined, `unexpected ${domain.domain} error: ${domain.error}`);
		}
		assert.equal(
			status.domains.find((domain) => domain.domain === "sessions")?.selection,
			`SQLite ${expectedSessionDb}`,
		);
		assert.equal(readFileSync(claimFile, "utf8"), claimBeforeRefresh);
		assert.deepEqual(
			readdirSync(moved).filter((entry) => entry.endsWith(".tmp")),
			[],
		);

		fsFaults.renameTargets.clear();
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(current, {}), moved);
		assert.equal(JSON.parse(readFileSync(claimFile, "utf8")).relativePath, "main");
	},
);

test("sibling and clone lookups do not refresh another owner's parent claim record (#5242)", async () => {
	const home = join(root, "self-only-refresh-home");
	useHome(home);
	const original = join(root, "self-only-refresh-parent");
	const moved = join(root, "self-only-refresh-moved");
	const agent = join(original, "a1");
	const sibling = join(original, "sibling");
	mkdirSync(agent, { recursive: true });
	mkdirSync(sibling, { recursive: true });
	mkdirSync(join(original, "workflows"), { recursive: true });
	writeFileSync(join(original, "workflows", "journal.sqlite"), "");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));

	assert.equal(storageHomeDir(agent, {}), original);

	cpSync(original, moved, { recursive: true });
	rmSync(original, { recursive: true });
	const current = join(moved, "main");
	const movedSibling = join(moved, "sibling");
	renameSyncWithRetry(join(moved, "a1"), current);
	resetStorageHomeCacheForTests();

	const claimFile = join(moved, ".atomic-storage-parent-owner");
	const staleClaimRaw = readFileSync(claimFile, "utf8");
	const staleClaim = JSON.parse(staleClaimRaw) as { identity?: string; relativePath?: string };
	assert.equal(staleClaim.relativePath, "a1");

	assert.equal(storageHomeDir(movedSibling, {}), movedSibling);
	assert.equal(defaultSessionDatabasePath(movedSibling, {}), join(movedSibling, "workflows", "journal.sqlite"));
	assert.equal(coLocatesWorkflowStore(movedSibling, {}), true);
	assert.deepEqual(selectSessionStorage(root, { agentDir: movedSibling, settings: {} }), {
		kind: "sqlite",
		path: join(movedSibling, "workflows", "journal.sqlite"),
	});
	const siblingStore = await resolveSessionStore(root, { agentDir: movedSibling, settings: {} });
	try {
		assert.equal(siblingStore.descriptor.location, join(movedSibling, "workflows", "journal.sqlite"));
	} finally {
		await siblingStore.close();
	}
	assert.equal(readFileSync(claimFile, "utf8"), staleClaimRaw);

	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(current, {}), moved);
	const refreshedClaimRaw = readFileSync(claimFile, "utf8");
	const refreshedClaim = JSON.parse(refreshedClaimRaw) as { identity?: string; relativePath?: string };
	assert.equal(refreshedClaim.relativePath, "main");
	assert.notEqual(refreshedClaim.identity, staleClaim.identity);

	const oldNameClone = join(moved, "a1");
	const backupClone = join(moved, "main-backup");
	cpSync(current, oldNameClone, { recursive: true });
	cpSync(current, backupClone, { recursive: true });
	resetStorageHomeCacheForTests();

	assert.equal(storageHomeDir(oldNameClone, {}), oldNameClone);
	assert.equal(storageHomeDir(backupClone, {}), backupClone);
	assert.equal(readFileSync(claimFile, "utf8"), refreshedClaimRaw);
	assert.equal(storageHomeDir(current, {}), moved);
});

test("a rejected clone with its own relative session store retains that store when the parent directory is read-only (#5242)", async () => {
	const home = join(root, "ro-parent-rejected-clone-home");
	useHome(home);
	const original = join(root, "ro-parent-rejected-clone-parent");
	const moved = join(root, "ro-parent-rejected-clone-moved");
	const agent = join(original, "a1");
	const settings = { sessions: { storage: { dir: "sessions" } } };
	mkdirSync(join(agent, "sessions"), { recursive: true });
	mkdirSync(join(original, "sessions"), { recursive: true });
	mkdirSync(join(original, "workflows"), { recursive: true });
	writeFileSync(join(agent, "sessions", "old.jsonl"), "{}\n");
	writeFileSync(join(original, "workflows", "journal.sqlite"), "");
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings));
	assert.equal(defaultSessionDatabasePath(agent, settings), join(original, "workflows", "journal.sqlite"));

	cpSync(original, moved, { recursive: true });
	rmSync(original, { recursive: true });
	const current = join(moved, "a1");
	const currentSettings = { sessions: { storage: { dir: "new-sessions" } } };
	mkdirSync(join(moved, "new-sessions"), { recursive: true });
	mkdirSync(join(current, "new-sessions"), { recursive: true });
	writeFileSync(join(current, "settings.json"), JSON.stringify(currentSettings));

	const sessionId = "99999999-9999-4999-8999-999999999999";
	const store = await resolveSessionStore(root, {
		agentDir: current,
		sessionStore: { kind: "jsonl", dir: join(current, "new-sessions") },
	});
	await store.create({ id: sessionId, version: 4, createdAt: "2026-11-16T00:00:00.000Z", cwd: root }, []);
	await store.close();

	fsFaults.readOnlyDirs.set(moved, "EACCES");
	resetStorageHomeCacheForTests();

	assert.equal(defaultSessionDatabasePath(current, currentSettings), join(current, "workflows", "journal.sqlite"));
	assert.deepEqual(selectSessionStorage(root, { agentDir: current, settings: currentSettings }), {
		kind: "jsonl",
		dir: join(current, "new-sessions"),
	});
	const restored = await resolveSessionStore(root, { agentDir: current, settings: currentSettings });
	try {
		assert.equal((await restored.readHeader(sessionId))?.id, sessionId);
	} finally {
		await restored.close();
	}
});

test("a moved and renamed owner keeps its parent store when a sibling or recreated old-name directory reuses the deleted owner's decision inode (#5242)", async () => {
	const home = join(root, "inode-reuse-home");
	useHome(home);
	for (const recordVariant of ["current", "legacy-minimal"] as const) {
		fsFaults.statOverrides.clear();
		const original = join(root, `inode-reuse-orig-${recordVariant}`);
		const moved = join(root, `inode-reuse-moved-${recordVariant}`);
		const agent = join(original, "a1");
		const sibling = join(original, "sibling");
		mkdirSync(agent, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		mkdirSync(join(original, "workflows"), { recursive: true });
		writeFileSync(join(original, "workflows", "journal.sqlite"), "");
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));

		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(agent, {}), original);
		const origHomeStat = statSync(join(agent, ".atomic-storage-home"), { bigint: true });

		if (recordVariant === "legacy-minimal") {
			const claimPath = join(original, ".atomic-storage-parent-owner");
			const parsed = JSON.parse(readFileSync(claimPath, "utf8")) as Record<string, unknown>;
			delete parsed.decisionId;
			delete parsed.directoryIdentity;
			writeFileSync(claimPath, `${JSON.stringify(parsed)}\n`);
		}

		cpSync(original, moved, { recursive: true });
		rmSync(original, { recursive: true });
		const current = join(moved, "main");
		const movedSibling = join(moved, "sibling");
		renameSyncWithRetry(join(moved, "a1"), current);

		const claimFile = join(moved, ".atomic-storage-parent-owner");
		const staleClaimRaw = readFileSync(claimFile, "utf8");

		// Simulate the sibling's new .atomic-storage-home reusing the deleted owner's inode.
		fsFaults.statOverrides.set(resolve(join(movedSibling, ".atomic-storage-home")), {
			dev: origHomeStat.dev,
			ino: origHomeStat.ino,
			birthtimeNs: origHomeStat.birthtimeNs,
		});
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(movedSibling, {}), movedSibling);
		assert.equal(readFileSync(claimFile, "utf8"), staleClaimRaw);

		if (recordVariant === "legacy-minimal") {
			// A minimal record without decisionId keeps existing behavior and never breaks sibling isolation.
			resetStorageHomeCacheForTests();
			assert.equal(storageHomeDir(movedSibling, {}), movedSibling);
			continue;
		}

		// Also verify a brand-new sibling at the recorded old name ("a1") whose settled .atomic-storage-home reuses
		// the deleted owner's decision inode (fast-path exact check). Create the directory before removing a fresh
		// copy's original so its directory inode is distinct while statOverrides injects the reused decision inode.
		const fpOrig = join(root, `inode-reuse-fp-orig-${recordVariant}`);
		const fpMoved = join(root, `inode-reuse-fp-moved-${recordVariant}`);
		const fpAgent = join(fpOrig, "a1");
		mkdirSync(fpAgent, { recursive: true });
		mkdirSync(join(fpOrig, "workflows"), { recursive: true });
		writeFileSync(join(fpOrig, "workflows", "journal.sqlite"), "");
		writeFileSync(join(fpAgent, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(fpAgent, {}), fpOrig);
		const fpOrigHomeStat = statSync(join(fpAgent, ".atomic-storage-home"), { bigint: true });

		cpSync(fpOrig, fpMoved, { recursive: true });
		const fpCurrent = join(fpMoved, "main");
		const recreatedOldName = join(fpMoved, "a1");
		renameSyncWithRetry(join(fpMoved, "a1"), fpCurrent);
		mkdirSync(recreatedOldName, { recursive: true });
		rmSync(fpOrig, { recursive: true });

		const fpClaimFile = join(fpMoved, ".atomic-storage-parent-owner");
		const fpStaleClaimRaw = readFileSync(fpClaimFile, "utf8");
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(recreatedOldName, {}), recreatedOldName);
		assert.equal(readFileSync(fpClaimFile, "utf8"), fpStaleClaimRaw);
		fsFaults.statOverrides.set(resolve(join(recreatedOldName, ".atomic-storage-home")), {
			dev: fpOrigHomeStat.dev,
			ino: fpOrigHomeStat.ino,
			birthtimeNs: fpOrigHomeStat.birthtimeNs,
		});
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(recreatedOldName, {}), recreatedOldName);
		assert.equal(storageHomeDir(fpCurrent, {}), fpMoved);
		const fpRefreshedClaim = JSON.parse(readFileSync(fpClaimFile, "utf8")) as { relativePath?: string };
		assert.equal(fpRefreshedClaim.relativePath, "main");

		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(current, {}), moved);
		const refreshedClaim = JSON.parse(readFileSync(claimFile, "utf8")) as { relativePath?: string };
		assert.equal(refreshedClaim.relativePath, "main");
	}
});

test("relative storage target ownership rejects reused sibling decision inodes while preserving a local-home owner's target claim (#5242)", () => {
	const home = join(root, "target-reuse-home");
	useHome(home);
	const parent = join(root, "target-reuse-parent");
	const agent = join(parent, "a1");
	const current = join(parent, "main");
	const sibling = join(parent, "sibling");
	mkdirSync(agent, { recursive: true });
	mkdirSync(sibling, { recursive: true });
	writeFileSync(join(parent, "history.sqlite"), "history");
	const settings = { sessions: { storage: { path: "history.sqlite" } } };

	// Custom local-home owner (settled without parent workflows -> .atomic-storage-home has no parentOwner).
	assert.equal(storageHomeDir(agent, {}), agent);
	assert.deepEqual(selectSessionStorage(root, { agentDir: agent, settings }), {
		kind: "sqlite",
		path: join(parent, "history.sqlite"),
	});
	const origHomeStat = statSync(join(agent, ".atomic-storage-home"), { bigint: true });
	const ownerDecision = JSON.parse(readFileSync(join(agent, ".atomic-storage-home"), "utf8")) as {
		parentOwner?: string;
	};
	assert.equal(ownerDecision.parentOwner, undefined);

	// Steady state: local-home owner keeps its target claim.
	resetStorageHomeCacheForTests();
	assert.deepEqual(selectSessionStorage(root, { agentDir: agent, settings }), {
		kind: "sqlite",
		path: join(parent, "history.sqlite"),
	});

	// Replace `a1` by copying to `main` and removing `a1` (freeing `a1`'s inodes while keeping `parent/history.sqlite`
	// and its target claim intact). Then sibling's .atomic-storage-home reuses `origHomeStat`'s inode.
	cpSync(agent, current, { recursive: true });
	rmSync(agent, { recursive: true });
	fsFaults.statOverrides.set(resolve(join(sibling, ".atomic-storage-home")), {
		dev: origHomeStat.dev,
		ino: origHomeStat.ino,
		birthtimeNs: origHomeStat.birthtimeNs,
	});
	resetStorageHomeCacheForTests();
	assert.deepEqual(selectSessionStorage(root, { agentDir: sibling, settings }), {
		kind: "sqlite",
		path: join(sibling, "history.sqlite"),
	});
	resetStorageHomeCacheForTests();
	assert.deepEqual(selectSessionStorage(root, { agentDir: current, settings }), {
		kind: "sqlite",
		path: join(parent, "history.sqlite"),
	});
});

test("in-place birthtime changes on unchanged inodes keep parent and relative target ownership intact (#5242)", () => {
	const home = join(root, "btime-parity-home");
	useHome(home);
	const settings = { sessions: { storage: { path: "history.sqlite" } } };

	// 1. Local-home target owner with its own workflows store (mutated birthtime on parent, agent, and decision file).
	const targetParent = join(root, "btime-target-parent");
	const targetAgent = join(targetParent, "a1");
	mkdirSync(join(targetAgent, "workflows"), { recursive: true });
	writeFileSync(join(targetAgent, "workflows", "journal.sqlite"), "local-workflows");
	writeFileSync(join(targetParent, "history.sqlite"), "shared-target");
	assert.equal(storagePathBaseDir("history.sqlite", targetAgent, settings), targetParent);

	const parentStat = statSync(targetParent, { bigint: true });
	const agentStat = statSync(targetAgent, { bigint: true });
	const homeFileStat = statSync(join(targetAgent, ".atomic-storage-home"), { bigint: true });
	fsFaults.statOverrides.set(resolve(targetParent), { birthtimeNs: parentStat.birthtimeNs - 86_400_000_000_000n });
	fsFaults.statOverrides.set(resolve(targetAgent), { birthtimeNs: agentStat.birthtimeNs - 86_400_000_000_000n });
	fsFaults.statOverrides.set(resolve(join(targetAgent, ".atomic-storage-home")), {
		birthtimeNs: homeFileStat.birthtimeNs - 86_400_000_000_000n,
	});
	resetStorageHomeCacheForTests();
	assert.equal(storagePathBaseDir("history.sqlite", targetAgent, settings), targetParent);

	// 2. Read-only adopting owner (no decisionId) and renamed owner beside a backup clone when parent birthtime changes.
	fsFaults.statOverrides.clear();
	const roParent = join(root, "btime-ro-parent");
	const roAgent = join(roParent, "a1");
	mkdirSync(roAgent, { recursive: true });
	mkdirSync(join(roParent, "workflows"), { recursive: true });
	writeFileSync(join(roParent, "workflows", "journal.sqlite"), "sessions");
	fsFaults.readOnlyDirs.set(roAgent, "EACCES");
	assert.equal(storageHomeDir(roAgent, {}), roParent);
	const roParentStat = statSync(roParent, { bigint: true });
	fsFaults.statOverrides.set(resolve(roParent), { birthtimeNs: roParentStat.birthtimeNs + 10_000_000n });
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(roAgent, {}), roParent);

	fsFaults.readOnlyDirs.clear();
	fsFaults.statOverrides.clear();
	const cloneParent = join(root, "btime-clone-parent");
	const cloneAgent = join(cloneParent, "a1");
	const cloneRenamed = join(cloneParent, "main");
	const backupClone = join(cloneParent, "a1-backup");
	mkdirSync(cloneAgent, { recursive: true });
	mkdirSync(join(cloneParent, "workflows"), { recursive: true });
	writeFileSync(join(cloneParent, "workflows", "journal.sqlite"), "sessions");
	assert.equal(storageHomeDir(cloneAgent, {}), cloneParent);
	cpSync(cloneAgent, backupClone, { recursive: true });
	renameSyncWithRetry(cloneAgent, cloneRenamed);
	const cloneParentStat = statSync(cloneParent, { bigint: true });
	fsFaults.statOverrides.set(resolve(cloneParent), { birthtimeNs: cloneParentStat.birthtimeNs - 86_400_000_000_000n });
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(cloneRenamed, {}), cloneParent);
	assert.equal(storageHomeDir(backupClone, {}), backupClone);
});

test("container moves, recreated owner directories keeping the decision file inode, and bind mounts keep ownership intact (#5242)", () => {
	const home = join(root, "container-move-home");
	useHome(home);
	const settings = { sessions: { storage: { path: "history.sqlite" } } };

	// 1. Moving all entries into a new container directory (new parent inode, children keep inodes).
	const srcParent = join(root, "move-contents-src");
	const dstParent = join(root, "move-contents-dst");
	const srcAgent = join(srcParent, "a1");
	mkdirSync(join(srcAgent, "workflows"), { recursive: true });
	writeFileSync(join(srcAgent, "workflows", "journal.sqlite"), "local-workflows");
	writeFileSync(join(srcParent, "history.sqlite"), "shared-target");
	assert.equal(storagePathBaseDir("history.sqlite", srcAgent, settings), srcParent);
	mkdirSync(dstParent, { recursive: true });
	for (const entry of readdirSync(srcParent)) {
		renameSyncWithRetry(join(srcParent, entry), join(dstParent, entry));
	}
	resetStorageHomeCacheForTests();
	assert.equal(storagePathBaseDir("history.sqlite", join(dstParent, "a1"), settings), dstParent);

	// Read-only adopting owner moved into a new container directory.
	const roSrc = join(root, "move-contents-ro-src");
	const roDst = join(root, "move-contents-ro-dst");
	const roAgent = join(roSrc, "a1");
	mkdirSync(roAgent, { recursive: true });
	mkdirSync(join(roSrc, "workflows"), { recursive: true });
	writeFileSync(join(roSrc, "workflows", "journal.sqlite"), "sessions");
	fsFaults.readOnlyDirs.set(roAgent, "EACCES");
	assert.equal(storageHomeDir(roAgent, {}), roSrc);
	fsFaults.readOnlyDirs.clear();
	mkdirSync(roDst, { recursive: true });
	for (const entry of readdirSync(roSrc)) {
		renameSyncWithRetry(join(roSrc, entry), join(roDst, entry));
	}
	fsFaults.readOnlyDirs.set(join(roDst, "a1"), "EACCES");
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(join(roDst, "a1"), {}), roDst);
	fsFaults.readOnlyDirs.clear();

	// 2. Recreating the owner directory (or hardlink backup restore) while keeping .atomic-storage-home's inode.
	const recParent = join(root, "recreate-dir-parent");
	const recAgent = join(recParent, "a1");
	mkdirSync(join(recAgent, "workflows"), { recursive: true });
	writeFileSync(join(recAgent, "workflows", "journal.sqlite"), "local-workflows");
	writeFileSync(join(recParent, "history.sqlite"), "shared-target");
	assert.equal(storagePathBaseDir("history.sqlite", recAgent, settings), recParent);
	const tmpAgent = join(recParent, "a1-tmp");
	mkdirSync(tmpAgent);
	for (const entry of readdirSync(recAgent)) {
		renameSyncWithRetry(join(recAgent, entry), join(tmpAgent, entry));
	}
	rmSync(recAgent, { recursive: true });
	renameSyncWithRetry(tmpAgent, recAgent);
	resetStorageHomeCacheForTests();
	assert.equal(storagePathBaseDir("history.sqlite", recAgent, settings), recParent);

	// 3. Bind mount (child on a different device mounted under a recreated container parent).
	const bmParent = join(root, "bind-mount-parent");
	const bmAgent = join(bmParent, "a1");
	mkdirSync(join(bmAgent, "workflows"), { recursive: true });
	writeFileSync(join(bmAgent, "workflows", "journal.sqlite"), "local-workflows");
	writeFileSync(join(bmParent, "history.sqlite"), "shared-target");
	fsFaults.statOverrides.set(resolve(bmParent), { dev: 100n, ino: 1001n });
	fsFaults.statOverrides.set(resolve(bmAgent), { dev: 200n, ino: 2001n });
	assert.equal(storagePathBaseDir("history.sqlite", bmAgent, settings), bmParent);
	// Container parent recreated on dev 100 with a new inode; bind-mounted child on dev 200 keeps its inodes.
	fsFaults.statOverrides.set(resolve(bmParent), { dev: 100n, ino: 1002n });
	resetStorageHomeCacheForTests();
	assert.equal(storagePathBaseDir("history.sqlite", bmAgent, settings), bmParent);
});

test("deleting an owner's decision file beside a backup clone retains ownership on both inode and zero-inode filesystems (#5242)", () => {
	const home = join(root, "deleted-decision-clone-home");
	useHome(home);
	for (const zeroIno of [false, true]) {
		fsFaults.globalZeroIno = zeroIno;
		const parent = join(root, `deleted-decision-parent-${zeroIno ? "zeroino" : "ino"}`);
		const agent = join(parent, "a1");
		const clone = join(parent, "a1-backup");
		mkdirSync(agent, { recursive: true });
		mkdirSync(join(parent, "workflows"), { recursive: true });
		writeFileSync(join(parent, "workflows", "journal.sqlite"), "sessions");
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(agent, {}), parent);
		cpSync(agent, clone, { recursive: true });
		rmSync(join(agent, ".atomic-storage-home"));
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(agent, {}), parent);
		assert.equal(storageHomeDir(clone, {}), clone);
	}
});

test("existing parent claims are never rewritten on upgrade or read-only parents, and warm target checks do not reread the owner's decision file (#5242)", () => {
	const home = join(root, "steady-state-home");
	useHome(home);

	// 1. Existing 0.10.4 claim format is preserved byte-for-byte with zero refresh write attempts (writable & RO parent).
	const parent = join(root, "steady-parent");
	const agent = join(parent, "a1");
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(parent, "workflows"), { recursive: true });
	writeFileSync(join(parent, "workflows", "journal.sqlite"), "sessions");
	assert.equal(storageHomeDir(agent, {}), parent);
	const claimFile = join(parent, ".atomic-storage-parent-owner");
	const claimObj = JSON.parse(readFileSync(claimFile, "utf8")) as Record<string, unknown>;
	assert.deepEqual(Object.keys(claimObj).sort(), [
		"decisionId",
		"directoryIdentity",
		"homeIdentity",
		"identity",
		"legacyTargets",
		"path",
		"relativePath",
	]);
	const initialClaimRaw = readFileSync(claimFile, "utf8");

	fsFaults.recordedWriteAttempts.length = 0;
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(agent, {}), parent);
	assert.equal(readFileSync(claimFile, "utf8"), initialClaimRaw);
	assert.deepEqual(
		fsFaults.recordedWriteAttempts.filter((p) => p.includes(".atomic-storage-parent-owner.") && p.endsWith(".tmp")),
		[],
	);

	fsFaults.readOnlyDirs.set(parent, "EACCES");
	fsFaults.recordedWriteAttempts.length = 0;
	resetStorageHomeCacheForTests();
	assert.equal(storageHomeDir(agent, {}), parent);
	assert.deepEqual(
		fsFaults.recordedWriteAttempts.filter((p) => p.includes(".atomic-storage-parent-owner.") && p.endsWith(".tmp")),
		[],
	);
	fsFaults.readOnlyDirs.clear();

	// 2. Warm target lookup reuses the settled owner's decisionId without rereading .atomic-storage-home.
	const targetParent = join(root, "steady-target-parent");
	const targetAgent = join(targetParent, "a1");
	mkdirSync(targetAgent, { recursive: true });
	writeFileSync(join(targetParent, "history.sqlite"), "history");
	const settings = { sessions: { storage: { path: "history.sqlite" } } };
	assert.equal(storagePathBaseDir("history.sqlite", targetAgent, settings), targetParent);

	fsFaults.recordedReads.length = 0;
	for (let index = 0; index < 3; index++) {
		assert.equal(storagePathBaseDir("history.sqlite", targetAgent, settings), targetParent);
	}
	const decisionReads = fsFaults.recordedReads.filter((p) => p === resolve(join(targetAgent, ".atomic-storage-home")));
	assert.deepEqual(decisionReads, []);
});

test("stale cached decision IDs never reject a live refreshed owner, and symlinked or sibling lookups never reread another owner's decision file (#5242)", () => {
	const settings = { sessions: { storage: { path: "history.sqlite" } } };
	const refreshedId = "22222222-2222-4222-8222-222222222222";

	// 1. Stale cached decisionId on a local-home target owner (with own workflows/journal.sqlite) after live disk refresh.
	const staleHome = join(root, "stale-cache-home");
	useHome(staleHome);
	const staleParent = join(root, "stale-cache-parent");
	const staleAgent = join(staleParent, "a1");
	mkdirSync(join(staleAgent, "workflows"), { recursive: true });
	writeFileSync(join(staleAgent, "workflows", "journal.sqlite"), "local-workflows");
	writeFileSync(join(staleParent, "history.sqlite"), "shared-sessions");
	assert.equal(storagePathBaseDir("history.sqlite", staleAgent, settings), staleParent);

	const staleDecisionFile = join(staleAgent, ".atomic-storage-home");
	const staleDecision = JSON.parse(readFileSync(staleDecisionFile, "utf8")) as Record<string, unknown>;
	writeFileSync(staleDecisionFile, `${JSON.stringify({ ...staleDecision, id: refreshedId })}\n`);
	for (const entry of readdirSync(staleParent)) {
		if (!entry.startsWith(".atomic-storage-target-")) continue;
		const claimPath = join(staleParent, entry);
		const owner = JSON.parse(readFileSync(claimPath, "utf8")) as Record<string, unknown>;
		writeFileSync(claimPath, `${JSON.stringify({ ...owner, decisionId: refreshedId })}\n`);
	}
	// Warm lookup without resetting cache must read live disk and keep staleParent without writing a .local marker.
	assert.equal(storagePathBaseDir("history.sqlite", staleAgent, settings), staleParent);
	assert.deepEqual(
		readdirSync(staleAgent).filter((name) => name.startsWith(".atomic-storage-home.local-")),
		[],
	);

	// 2. Symlinked HOME warm default-target lookup and sibling lookups never reread the owner's .atomic-storage-home.
	const realHome = join(root, "sym-real-home");
	const linkHome = join(root, "sym-link-home");
	const realDefAgent = join(realHome, ".atomic", "agent");
	mkdirSync(realDefAgent, { recursive: true });
	writeFileSync(join(realHome, ".atomic", "history.sqlite"), "shared");
	symlinkSync(realHome, linkHome, "junction");
	useHome(linkHome);
	const linkDefAgent = join(linkHome, ".atomic", "agent");
	assert.equal(storagePathBaseDir("history.sqlite", linkDefAgent, settings), join(linkHome, ".atomic"));
	fsFaults.recordedReads.length = 0;
	for (let index = 0; index < 3; index++) {
		assert.equal(storagePathBaseDir("history.sqlite", linkDefAgent, settings), join(linkHome, ".atomic"));
	}
	assert.deepEqual(
		fsFaults.recordedReads.filter((p) => p.endsWith(".atomic-storage-home")),
		[],
	);

	// Sibling checks against another owner's parent/target never read that owner's .atomic-storage-home.
	useHome(staleHome);
	const sibParent = join(root, "sib-no-read-parent");
	const sibOwner = join(sibParent, "a1");
	const sibOther = join(sibParent, "a2");
	mkdirSync(sibOwner, { recursive: true });
	mkdirSync(sibOther, { recursive: true });
	mkdirSync(join(sibParent, "workflows"), { recursive: true });
	writeFileSync(join(sibParent, "workflows", "journal.sqlite"), "sessions");
	writeFileSync(join(sibParent, "history.sqlite"), "shared");
	assert.equal(storageHomeDir(sibOwner, {}), sibParent);
	assert.equal(storagePathBaseDir("history.sqlite", sibOwner, settings), sibParent);

	const ownerDecisionPath = resolve(join(sibOwner, ".atomic-storage-home"));
	fsFaults.unreadableFiles.set(ownerDecisionPath, "EACCES");
	fsFaults.recordedReads.length = 0;
	resetStorageHomeCacheForTests();
	assert.equal(coLocatesWorkflowStore(sibOther, {}), true);
	assert.deepEqual(
		fsFaults.recordedReads.filter((p) => p === ownerDecisionPath),
		[],
	);
	fsFaults.unreadableFiles.clear();
	assert.equal(storagePathBaseDir("history.sqlite", sibOther, settings), sibOther);
	fsFaults.unreadableFiles.set(ownerDecisionPath, "EACCES");
	fsFaults.recordedReads.length = 0;
	assert.equal(storagePathBaseDir("history.sqlite", sibOther, settings), sibOther);
	assert.deepEqual(
		fsFaults.recordedReads.filter((p) => p === ownerDecisionPath),
		[],
	);

	// 3. Repointing a cached symlink from a1 to sibling a2 on warm storagePathBaseDir must isolate a2 (never leak a1's target).
	fsFaults.unreadableFiles.clear();
	const repointParent = join(root, "repoint-sym-parent");
	const repointA1 = join(repointParent, "a1");
	const repointA2 = join(repointParent, "a2");
	const repointLink = join(root, "repoint-sym-link");
	mkdirSync(repointA1, { recursive: true });
	mkdirSync(repointA2, { recursive: true });
	writeFileSync(join(repointParent, "history.sqlite"), "a1-private");
	symlinkSync(repointA1, repointLink, "junction");
	resetStorageHomeCacheForTests();
	assert.equal(storagePathBaseDir("history.sqlite", repointLink, settings), repointParent);
	rmSync(repointLink);
	symlinkSync(repointA2, repointLink, "junction");
	assert.equal(storagePathBaseDir("history.sqlite", repointLink, settings), repointLink);
});

test("in-place decision file replacement, zero-inode shares, and homeIdentity-false races keep ownership even beside a backup clone (#5242)", () => {
	const home = join(root, "inplace-replace-home");
	useHome(home);
	const settings = { sessions: { storage: { path: "history.sqlite" } } };
	const replacedId = "99999999-9999-4999-8999-999999999999";

	for (const zeroIno of [false, true]) {
		fsFaults.globalZeroIno = zeroIno;
		const suffix = zeroIno ? "zeroino" : "ino";

		// 1. Adopting owner + backup clone (carrying original decisionId) + in-place decision overwrite on owner.
		const adParent = join(root, `inplace-ad-${suffix}`);
		const adOwner = join(adParent, "a1");
		const adClone = join(adParent, "a1-backup");
		mkdirSync(adOwner, { recursive: true });
		mkdirSync(join(adParent, "workflows"), { recursive: true });
		writeFileSync(join(adParent, "workflows", "journal.sqlite"), "sessions");
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(adOwner, {}), adParent);
		cpSync(adOwner, adClone, { recursive: true });
		const adDecisionFile = join(adOwner, ".atomic-storage-home");
		const adDecision = JSON.parse(readFileSync(adDecisionFile, "utf8")) as Record<string, unknown>;
		if (zeroIno) rmSync(adDecisionFile);
		writeFileSync(adDecisionFile, `${JSON.stringify({ ...adDecision, id: replacedId })}\n`);
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(adOwner, {}), adParent);
		assert.equal(storageHomeDir(adClone, {}), adClone);

		// 2. Local-home target owner (with own workflows/journal.sqlite) + backup clone + in-place overwrite on owner.
		const tgtParent = join(root, `inplace-tgt-${suffix}`);
		const tgtOwner = join(tgtParent, "a1");
		const tgtClone = join(tgtParent, "a1-backup");
		mkdirSync(tgtOwner, { recursive: true });
		writeFileSync(join(tgtParent, "history.sqlite"), "shared");
		resetStorageHomeCacheForTests();
		assert.equal(storagePathBaseDir("history.sqlite", tgtOwner, settings), tgtParent);
		cpSync(tgtOwner, tgtClone, { recursive: true });
		mkdirSync(join(tgtOwner, "workflows"), { recursive: true });
		writeFileSync(join(tgtOwner, "workflows", "journal.sqlite"), "local-workflows");
		const tgtDecisionFile = join(tgtOwner, ".atomic-storage-home");
		const tgtDecision = JSON.parse(readFileSync(tgtDecisionFile, "utf8")) as Record<string, unknown>;
		if (zeroIno) rmSync(tgtDecisionFile);
		writeFileSync(tgtDecisionFile, `${JSON.stringify({ ...tgtDecision, id: replacedId })}\n`);
		resetStorageHomeCacheForTests();
		assert.equal(storagePathBaseDir("history.sqlite", tgtOwner, settings), tgtParent);
		assert.equal(storagePathBaseDir("history.sqlite", tgtClone, settings), tgtClone);
		assert.deepEqual(
			readdirSync(tgtOwner).filter((name) => name.startsWith(".atomic-storage-home.local-")),
			[],
		);

		// 3. Owner claim missing directoryIdentity (no clone) keeps ownership on in-place decision overwrite.
		const noDirParent = join(root, `inplace-nodir-${suffix}`);
		const noDirOwner = join(noDirParent, "a1");
		mkdirSync(noDirOwner, { recursive: true });
		mkdirSync(join(noDirParent, "workflows"), { recursive: true });
		writeFileSync(join(noDirParent, "workflows", "journal.sqlite"), "sessions");
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(noDirOwner, {}), noDirParent);
		const noDirClaim = join(noDirParent, ".atomic-storage-parent-owner");
		const noDirClaimObj = JSON.parse(readFileSync(noDirClaim, "utf8")) as Record<string, unknown>;
		delete noDirClaimObj.directoryIdentity;
		writeFileSync(noDirClaim, `${JSON.stringify(noDirClaimObj)}\n`);
		const noDirDecFile = join(noDirOwner, ".atomic-storage-home");
		const noDirDec = JSON.parse(readFileSync(noDirDecFile, "utf8")) as Record<string, unknown>;
		if (zeroIno) rmSync(noDirDecFile);
		writeFileSync(noDirDecFile, `${JSON.stringify({ ...noDirDec, id: replacedId })}\n`);
		resetStorageHomeCacheForTests();
		assert.equal(storageHomeDir(noDirOwner, {}), noDirParent);
	}

	// 4. homeIdentity: false + decisionId (settle race) + backup clone + deleted/recreated decision file.
	fsFaults.globalZeroIno = false;
	const raceParent = join(root, "home-identity-false-race");
	const raceOwner = join(raceParent, "a1");
	const raceClone = join(raceParent, "a1-backup");
	mkdirSync(join(raceOwner, "workflows"), { recursive: true });
	writeFileSync(join(raceOwner, "workflows", "journal.sqlite"), "local-workflows");
	writeFileSync(join(raceParent, "history.sqlite"), "shared");
	resetStorageHomeCacheForTests();
	assert.equal(storagePathBaseDir("history.sqlite", raceOwner, settings), raceParent);
	cpSync(raceOwner, raceClone, { recursive: true });
	const ownerDirStat = statSync(raceOwner, { bigint: true });
	for (const entry of readdirSync(raceParent)) {
		if (!entry.startsWith(".atomic-storage-target-")) continue;
		const claimPath = join(raceParent, entry);
		const owner = JSON.parse(readFileSync(claimPath, "utf8")) as Record<string, unknown>;
		writeFileSync(
			claimPath,
			`${JSON.stringify({ ...owner, identity: `${ownerDirStat.dev}:${ownerDirStat.ino}`, homeIdentity: false })}\n`,
		);
	}
	const raceDecFile = join(raceOwner, ".atomic-storage-home");
	const raceDec = JSON.parse(readFileSync(raceDecFile, "utf8")) as Record<string, unknown>;
	rmSync(raceDecFile);
	writeFileSync(raceDecFile, `${JSON.stringify({ ...raceDec, id: replacedId })}\n`);
	resetStorageHomeCacheForTests();
	assert.equal(storagePathBaseDir("history.sqlite", raceOwner, settings), raceParent);
});
