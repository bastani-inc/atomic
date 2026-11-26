import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { FileSettingsStorage } from "../../packages/coding-agent/src/core/settings-storage.js";
import { isTeamProfileError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	POSTGRES_ADAPTER_PACKAGE,
	STORAGE_TOKEN_FILE,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import { joinSharedDatabase } from "../../packages/coding-agent/src/core/storage/team.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const observed = vi.hoisted(() => ({
	settingsLocked: (): boolean => false,
	tokenOperations: [] as { op: "read" | "publish" | "delete"; locked: boolean }[],
	settingsRenameFails: false,
	tokenDeleteFails: false,
	tokenFile: /[\\/]storage-token\.[\da-f-]+$/,
	tokenTemporary: /[\\/]storage-token\.[\da-f-]+\.\d+\.tmp$/,
}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			if (observed.tokenFile.test(String(args[0])))
				observed.tokenOperations.push({ op: "read", locked: observed.settingsLocked() });
			return fs.readFileSync(...args);
		},
		renameSync: (...args: Parameters<typeof fs.renameSync>) => {
			if (observed.tokenTemporary.test(String(args[0])))
				observed.tokenOperations.push({ op: "publish", locked: observed.settingsLocked() });
			if (observed.settingsRenameFails && /[\\/]settings\.json$/.test(String(args[1]))) {
				throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" });
			}
			return fs.renameSync(...args);
		},
		rmSync: (...args: Parameters<typeof fs.rmSync>) => {
			if (observed.tokenFile.test(String(args[0]))) {
				observed.tokenOperations.push({ op: "delete", locked: observed.settingsLocked() });
				if (observed.tokenDeleteFails)
					throw Object.assign(new Error("EBUSY: resource busy or locked, rm"), { code: "EBUSY" });
			}
			return fs.rmSync(...args);
		},
	};
});

const JOIN_SCENARIO_TIMEOUT_MS = 60_000;
const TOKEN = "team-secret-password";
const URL_ = "postgres://atomic@team.example.com/atomic";
const STORAGE_VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
];

let root: string;
let agentDir: string;
let project: string;
let packageRoot: string;
let passwordFile: string;
let settingsPath: string;
let releaseHeldLock: (() => void) | undefined;

beforeEach(async () => {
	for (const name of STORAGE_VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("team-settings-lock-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	settingsPath = join(agentDir, "settings.json");
	// A package installed as the PostgreSQL adapter, whose database answers the join's SELECT 1.
	packageRoot = join(root, "adapter");
	mkdirSync(packageRoot);
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: POSTGRES_ADAPTER_PACKAGE, type: "module", atomic: { storageAdapters: ["./adapter.js"] } }),
	);
	writeFileSync(
		join(packageRoot, "adapter.js"),
		"export default { atomicStorageAdapter: 1, async openDatabase() { return { async get() { return { ok: 1 }; }, async close() {} }; } };\n",
	);
	passwordFile = join(root, "password");
	writeFileSync(passwordFile, TOKEN);
	// A join or leave holds the settings lock synchronously, so nothing refreshes its mtime meanwhile. On Windows a
	// failed settings write retries its rename for seconds, more under load, so the default 10 s staleness would report
	// a lock this process still holds as free. No test outlives its timeout, so its locks never look stale here.
	observed.settingsLocked = () =>
		lockfile.checkSync(settingsPath, { realpath: false, stale: JOIN_SCENARIO_TIMEOUT_MS });
	observed.tokenOperations = [];
	observed.settingsRenameFails = false;
	observed.tokenDeleteFails = false;
	writeFileSync(settingsPath, JSON.stringify({ theme: "dark", packages: [packageRoot] }, null, 2));
});

afterEach(async () => {
	releaseHeldLock?.();
	releaseHeldLock = undefined;
	observed.settingsRenameFails = false;
	observed.tokenDeleteFails = false;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

function joinTeamDatabase(): ReturnType<typeof joinSharedDatabase> {
	return joinSharedDatabase({ url: URL_, passwordFile, agentDir, cwd: project }, "cli");
}

function settingsText(): string {
	return readFileSync(settingsPath, "utf8");
}

function tokenFiles(): string[] {
	return readdirSync(agentDir).filter((name) => name.startsWith(`${STORAGE_TOKEN_FILE}.`));
}

function beforeSettingsWriteLock(action: () => void): void {
	const lock = FileSettingsStorage.prototype.withPrimaryWriteLock;
	let fired = false;
	vi.spyOn(FileSettingsStorage.prototype, "withPrimaryWriteLock").mockImplementation(function (
		this: FileSettingsStorage,
		...args
	) {
		if (!fired) {
			fired = true;
			action();
		}
		return lock.apply(this, args);
	});
}

describe("storage join serializes on the settings lock (#4320)", () => {
	test(
		"a join writes and reuses its password file only while holding the settings lock",
		async () => {
			const first = await joinTeamDatabase();
			assert.equal(first.token, "new");
			assert.deepEqual(observed.tokenOperations, [{ op: "publish", locked: true }]);
			observed.tokenOperations = [];

			const second = await joinTeamDatabase();
			assert.equal(second.token, "reused");
			assert.deepEqual(observed.tokenOperations, [{ op: "read", locked: true }]);
			assert.equal(lockfile.checkSync(settingsPath, { realpath: false }), false);
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a reset that finishes before a join publishes cannot leave the join pointing at a deleted password file",
		async () => {
			const before = settingsText();
			const first = await joinTeamDatabase();
			assert.ok(first.tokenPath);
			const staleToken = first.tokenPath;
			beforeSettingsWriteLock(() => {
				writeFileSync(settingsPath, before);
				rmSync(staleToken, { force: true });
			});
			const second = await joinTeamDatabase();

			assert.ok(second.tokenPath);
			assert.equal(second.token, "new");
			assert.equal(second.replaced, undefined);
			assert.equal(existsSync(second.tokenPath), true);
			assert.equal(readFileSync(second.tokenPath, "utf8"), TOKEN);
			const saved = JSON.parse(settingsText());
			assert.equal(saved.theme, "dark");
			assert.equal(join(agentDir, saved.storage.secrets.password.file), second.tokenPath);
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a join that cannot get the settings lock fails as retryable settings-locked and changes nothing",
		async () => {
			const first = await joinTeamDatabase();
			assert.ok(first.tokenPath);
			const joined = settingsText();
			const filesBefore = tokenFiles();

			beforeSettingsWriteLock(() => {
				releaseHeldLock = lockfile.lockSync(settingsPath, { realpath: false });
			});
			const joinFailure = await joinTeamDatabase().then(
				() => assert.fail("joined while the settings were locked"),
				(error: Error) => error,
			);
			assert.ok(isTeamProfileError(joinFailure));
			assert.deepEqual([joinFailure.code, joinFailure.retryable], ["settings-locked", true]);
			assert.equal(settingsText(), joined);
			assert.deepEqual(tokenFiles(), filesBefore);
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a failed settings write removes the password file the join created and changes nothing else",
		async () => {
			const before = settingsText();
			observed.settingsRenameFails = true;

			const failure = await joinTeamDatabase().then(
				() => assert.fail("joined"),
				(error: Error) => error,
			);

			assert.ok(isTeamProfileError(failure));
			assert.equal(failure.code, "settings-write-failed");
			assert.equal(settingsText(), before);
			assert.deepEqual(tokenFiles(), []);
			assert.deepEqual(
				observed.tokenOperations.map(({ op, locked }) => [op, locked]),
				[
					["publish", true],
					["delete", true],
				],
			);
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a password file that cannot be removed after a failed settings write is kept as cleanupCause, not thrown",
		async () => {
			observed.settingsRenameFails = true;
			observed.tokenDeleteFails = true;

			const failure = await joinTeamDatabase().then(
				() => assert.fail("joined"),
				(error: Error) => error,
			);

			assert.ok(isTeamProfileError(failure));
			assert.equal(failure.code, "settings-write-failed");
			assert.equal((failure as { cleanupCause?: NodeJS.ErrnoException }).cleanupCause?.code, "EBUSY");
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);
});

describe("storage join when the settings change after its preflight (#4320)", () => {
	function failureOf<T>(run: () => Promise<T>): Promise<Error> {
		return run().then(
			() => assert.fail("completed"),
			(error: Error) => error,
		);
	}

	test(
		"a join over settings deleted after its preflight starts from empty settings",
		async () => {
			beforeSettingsWriteLock(() => rmSync(settingsPath));

			const joined = await joinTeamDatabase();

			assert.deepEqual(JSON.parse(settingsText()), { storage: joined.storage });
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a join over settings that stop being a JSON object fails as settings-unreadable before it writes a password file",
		async () => {
			const original = settingsText();
			for (const malformed of ["[]", "null", '"text"', "7", "{not json"]) {
				writeFileSync(settingsPath, original);
				observed.tokenOperations = [];
				beforeSettingsWriteLock(() => writeFileSync(settingsPath, malformed));

				const failure = await failureOf(joinTeamDatabase);

				assert.ok(isTeamProfileError(failure), malformed);
				assert.deepEqual([failure.code, failure.subject], ["settings-unreadable", settingsPath], malformed);
				assert.equal(settingsText(), malformed);
				assert.deepEqual(tokenFiles(), [], malformed);
				assert.deepEqual(observed.tokenOperations, [], malformed);
				vi.restoreAllMocks();
			}
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a settings file that parses to an array reports a TypeError cause that names no content",
		async () => {
			beforeSettingsWriteLock(() => writeFileSync(settingsPath, "[]"));

			const failure = await failureOf(joinTeamDatabase);

			assert.ok(isTeamProfileError(failure));
			assert.ok(failure.cause instanceof TypeError);
			assert.equal(failure.detail, "TypeError");
			assert.equal(failure.cause.message, "not a JSON object");
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);
});

describe("storage join password handling under the settings lock (#4320)", () => {
	test(
		"a join with a platform credential reads no password file and records no secret",
		async () => {
			await joinTeamDatabase();
			observed.tokenOperations = [];

			const joined = await joinSharedDatabase({ url: URL_, auth: "aws-iam", agentDir, cwd: project }, "cli");

			assert.equal(joined.token, "none");
			assert.equal(joined.tokenPath, undefined);
			assert.equal(joined.storage.secrets, undefined);
			assert.deepEqual(observed.tokenOperations, []);
			assert.equal(JSON.parse(settingsText()).storage.secrets, undefined);
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a failed settings write keeps the password file a join reused and records no cleanup failure",
		async () => {
			const first = await joinTeamDatabase();
			assert.ok(first.tokenPath);
			const joined = settingsText();
			observed.tokenOperations = [];
			observed.settingsRenameFails = true;

			const failure = await joinTeamDatabase().then(
				() => assert.fail("joined"),
				(error: Error) => error,
			);

			assert.ok(isTeamProfileError(failure));
			assert.equal(failure.code, "settings-write-failed");
			assert.equal(Object.hasOwn(failure, "cleanupCause"), false);
			assert.equal(existsSync(first.tokenPath), true);
			assert.equal(readFileSync(first.tokenPath, "utf8"), TOKEN);
			assert.equal(
				observed.tokenOperations.some(({ op }) => op === "delete"),
				false,
			);
			assert.equal(settingsText(), joined);
		},
		JOIN_SCENARIO_TIMEOUT_MS,
	);
});
