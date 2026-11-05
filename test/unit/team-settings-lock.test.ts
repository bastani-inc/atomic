import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { IntercomBrokerControl } from "../../packages/coding-agent/src/core/intercom-broker-control.js";
import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { FileSettingsStorage } from "../../packages/coding-agent/src/core/settings-storage.js";
import { isTeamProfileError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { LOCAL_SESSIONS_STORAGE, STORAGE_TOKEN_FILE } from "../../packages/coding-agent/src/core/storage/selection.js";
import { joinSharedDatabase, leaveTeamWith } from "../../packages/coding-agent/src/core/storage/team.js";
import { ProjectTrustStore } from "../../packages/coding-agent/src/core/trust-manager.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

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

const LIBSQL_SCENARIO_TIMEOUT_MS = 60_000;
const packageRoot = resolve(moduleDir(import.meta.url), "../../packages/storage-libsql");
const TOKEN = "team-secret-token";
const STORAGE_VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
	"ATOMIC_PROFILE",
	"ATOMIC_TEAM_URL",
	"ATOMIC_TEAM_TOKEN",
	"ATOMIC_TEAM_TOKEN_FILE",
	"ATOMIC_TEAM_PREFIX",
];
const control = { restartIntercomBroker: async () => ({ status: "not-running" }) } as unknown as IntercomBrokerControl;

let root: string;
let agentDir: string;
let project: string;
let databaseDirectory: string;
let databaseUrl: string;
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
	databaseDirectory = makeLibsqlDirectory();
	const path = join(databaseDirectory, "team.sqlite");
	databaseUrl = pathToFileURL(path).href;
	await (await openNodeSqliteDatabase(path)).close();
	observed.settingsLocked = () => lockfile.checkSync(settingsPath, { realpath: false });
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
	await removeLibsqlDirectory(databaseDirectory);
	removeTempDirectory(root);
});

function joinTeamDatabase(): ReturnType<typeof joinSharedDatabase> {
	return joinSharedDatabase({ url: databaseUrl, token: TOKEN, agentDir, cwd: project, pinLocalSessions: true }, "sdk");
}

function leave(onLeft?: () => void): ReturnType<typeof leaveTeamWith> {
	return leaveTeamWith(
		{ agentDir, cwd: project },
		{ loadControl: async () => control, ...(onLeft ? { onLeft } : {}) },
	);
}

function settingsText(): string {
	return readFileSync(settingsPath, "utf8");
}

function tokenFiles(): string[] {
	return readdirSync(agentDir).filter((name) => name.startsWith(`${STORAGE_TOKEN_FILE}.`));
}

function afterFirstSettingsRead(action: () => void): void {
	const read = FileSettingsStorage.prototype.withLock;
	let fired = false;
	vi.spyOn(FileSettingsStorage.prototype, "withLock").mockImplementation(function (
		this: FileSettingsStorage,
		...args
	) {
		read.apply(this, args);
		if (!fired && args[0] === "global") {
			fired = true;
			action();
		}
	});
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

describe("team join and leave serialize on the settings lock (#4320)", () => {
	test(
		"a join reuses its token file, and a leave checks and deletes it, only while holding the settings lock",
		async () => {
			const first = await joinTeamDatabase();
			assert.equal(first.token, "new");
			assert.deepEqual(observed.tokenOperations, [{ op: "publish", locked: true }]);
			observed.tokenOperations = [];

			const second = await joinTeamDatabase();
			assert.equal(second.token, "reused");
			assert.deepEqual(observed.tokenOperations, [{ op: "read", locked: true }]);
			observed.tokenOperations = [];

			const left = await leave();
			assert.deepEqual(left.deletedTokenFiles, [first.tokenPath]);
			assert.deepEqual(observed.tokenOperations, [{ op: "delete", locked: true }]);
			assert.equal(lockfile.checkSync(settingsPath, { realpath: false }), false);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a leave that finishes before a join publishes cannot leave the join pointing at a deleted token file",
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
			assert.deepEqual(saved.sessions, { storage: LOCAL_SESSIONS_STORAGE });
			assert.equal(join(dirname(agentDir), saved.storage.secrets.authToken.file), second.tokenPath);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a leave decides from the settings it reads under the lock, so it cannot erase a selection written after its first read",
		async () => {
			const first = await joinTeamDatabase();
			assert.ok(first.tokenPath);
			const newer = { ...JSON.parse(settingsText()), storage: { path: "shared.sqlite" } };
			afterFirstSettingsRead(() => writeFileSync(settingsPath, JSON.stringify(newer, null, 2)));

			const left = await leave();

			assert.deepEqual(left.removed, []);
			assert.deepEqual(left.kept, [
				{ key: "storage", reason: "changed" },
				{ key: "sessions.storage", reason: "storage-remains" },
			]);
			assert.deepEqual(left.deletedTokenFiles, []);
			assert.deepEqual(JSON.parse(settingsText()), newer);
			assert.equal(existsSync(first.tokenPath), true);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a join and a leave that cannot get the settings lock fail as retryable settings-locked and change nothing",
		async () => {
			const first = await joinTeamDatabase();
			assert.ok(first.tokenPath);
			const joined = settingsText();
			const filesBefore = tokenFiles();
			beforeSettingsWriteLock(() => {
				releaseHeldLock = lockfile.lockSync(settingsPath, { realpath: false });
			});

			const leaveFailure = await leave().then(
				() => assert.fail("left while the settings were locked"),
				(error: Error) => error,
			);
			assert.ok(isTeamProfileError(leaveFailure));
			assert.deepEqual([leaveFailure.code, leaveFailure.retryable], ["settings-locked", true]);
			assert.equal(settingsText(), joined);
			assert.deepEqual(tokenFiles(), filesBefore);
			releaseHeldLock?.();
			releaseHeldLock = undefined;
			vi.restoreAllMocks();

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
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a failed settings write removes the token file the join created and changes nothing else",
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
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a token file that cannot be removed after a failed settings write is kept as cleanupCause, not thrown",
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
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});

describe("team leave and a trusted project's remote storage (#4320)", () => {
	const remote = { adapter: "@example/sessions", options: { url: "libsql://project.example.turso.io" } };

	function writeProjectStorage(trusted: boolean): void {
		mkdirSync(join(project, ".atomic"), { recursive: true });
		writeFileSync(join(project, ".atomic", "settings.json"), JSON.stringify({ storage: remote }));
		new ProjectTrustStore(agentDir).set(project, trusted);
	}

	function effectiveSessions(): unknown {
		const settings = SettingsManager.create(project, agentDir, { projectTrusted: true }).getSettings();
		return selectSessionStorage(project, { agentDir, settings });
	}

	test(
		"keeps the local sessions pin, so transcripts never follow the project's storage",
		async () => {
			await joinTeamDatabase();
			writeProjectStorage(true);

			const left = await leave();

			assert.deepEqual(left.removed, ["storage"]);
			assert.deepEqual(left.kept, [{ key: "sessions.storage", reason: "storage-remains" }]);
			const saved = JSON.parse(settingsText());
			assert.equal(saved.storage, undefined);
			assert.deepEqual(saved.sessions, { storage: LOCAL_SESSIONS_STORAGE });
			assert.deepEqual(effectiveSessions(), { kind: "sqlite", path: join(root, "workflows", "journal.sqlite") });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"removes the pin when the project is not trusted, because its storage never applies",
		async () => {
			await joinTeamDatabase();
			writeProjectStorage(false);

			const left = await leave();

			assert.deepEqual(left.removed, ["storage", "sessions.storage"]);
			assert.deepEqual(left.kept, []);
			assert.deepEqual(JSON.parse(settingsText()), { theme: "dark", packages: [packageRoot] });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a leave that cannot read a locked project settings file names that file in settings-locked",
		async () => {
			await joinTeamDatabase();
			writeProjectStorage(true);
			const projectSettings = join(project, ".atomic", "settings.json");
			const joined = settingsText();
			releaseHeldLock = lockfile.lockSync(projectSettings, { realpath: false });

			const failure = await leave().then(
				() => assert.fail("left while the project settings were locked"),
				(error: Error) => error,
			);

			assert.ok(isTeamProfileError(failure));
			assert.deepEqual(
				[failure.code, failure.subject, failure.retryable],
				["settings-locked", projectSettings, true],
			);
			assert.equal(
				failure.hint,
				"Nothing was changed. Run the command again in a few seconds; a lock left by a killed process expires after 10 seconds.",
			);
			assert.equal(settingsText(), joined);
			assert.equal(tokenFiles().length, 1);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});

describe("team leave when the agent directory is the project's config directory (#4320)", () => {
	test(
		"removes the selection, the pin and the token file without waiting on a lock it already holds",
		async () => {
			agentDir = join(project, ".atomic");
			settingsPath = join(agentDir, "settings.json");
			mkdirSync(agentDir, { recursive: true });
			const original = { theme: "dark", packages: [packageRoot] };
			writeFileSync(settingsPath, JSON.stringify(original, null, 2));
			const joined = await joinTeamDatabase();
			assert.ok(joined.tokenPath);
			assert.equal(existsSync(joined.tokenPath), true);

			const left = await leave();

			assert.deepEqual(left.removed, ["storage", "sessions.storage"]);
			assert.deepEqual(left.kept, []);
			assert.deepEqual(left.deletedTokenFiles, [joined.tokenPath]);
			assert.equal(existsSync(joined.tokenPath), false);
			assert.deepEqual(JSON.parse(settingsText()), original);
			assert.deepEqual(tokenFiles(), []);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"keeps the pin and a token file that a lower-priority legacy project settings file still references",
		async () => {
			agentDir = join(project, ".atomic");
			settingsPath = join(agentDir, "settings.json");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark", packages: [packageRoot] }, null, 2));
			const joined = await joinTeamDatabase();
			assert.ok(joined.tokenPath);
			const legacy = join(project, ".pi", "settings.json");
			mkdirSync(dirname(legacy), { recursive: true });
			writeFileSync(legacy, JSON.stringify({ storage: JSON.parse(settingsText()).storage }));
			new ProjectTrustStore(agentDir).set(project, true);

			const left = await leave();

			assert.deepEqual(left.removed, ["storage"]);
			assert.deepEqual(left.kept, [{ key: "sessions.storage", reason: "storage-remains" }]);
			assert.deepEqual(left.keptTokenFiles, [joined.tokenPath]);
			assert.equal(existsSync(joined.tokenPath), true);
			assert.deepEqual(JSON.parse(settingsText()).sessions, { storage: LOCAL_SESSIONS_STORAGE });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});

describe("team join and leave when the settings change after their preflight (#4320)", () => {
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

			assert.deepEqual(JSON.parse(settingsText()), {
				storage: joined.storage,
				sessions: { storage: LOCAL_SESSIONS_STORAGE },
			});
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a join over settings that stop being a JSON object fails as settings-unreadable before it writes a token file",
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
		LIBSQL_SCENARIO_TIMEOUT_MS,
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
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a leave over settings that stop being a JSON object fails as settings-unreadable and changes nothing",
		async () => {
			const first = await joinTeamDatabase();
			assert.ok(first.tokenPath);
			beforeSettingsWriteLock(() => writeFileSync(settingsPath, "[]"));
			const onLeft = vi.fn();

			const failure = await failureOf(() => leave(onLeft));

			assert.ok(isTeamProfileError(failure));
			assert.deepEqual([failure.code, failure.subject], ["settings-unreadable", settingsPath]);
			assert.equal(settingsText(), "[]");
			assert.equal(existsSync(first.tokenPath), true);
			assert.equal(onLeft.mock.calls.length, 0);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a leave over settings deleted after its preflight changes nothing and recreates no file",
		async () => {
			await joinTeamDatabase();
			beforeSettingsWriteLock(() => rmSync(settingsPath));
			const onLeft = vi.fn();

			const left = await leave(onLeft);

			assert.deepEqual([left.removed, left.kept, left.deletedTokenFiles], [[], [], []]);
			assert.equal(existsSync(settingsPath), false);
			assert.equal(onLeft.mock.calls.length, 0);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});

describe("team join token handling under the settings lock (#4320)", () => {
	test(
		"a join without a token file reads no token file and records no secret",
		async () => {
			await joinTeamDatabase();
			observed.tokenOperations = [];

			const joined = await joinSharedDatabase(
				{ url: databaseUrl, agentDir, cwd: project, pinLocalSessions: true },
				"sdk",
			);

			assert.equal(joined.token, "none");
			assert.equal(joined.tokenPath, undefined);
			assert.equal(joined.storage.secrets, undefined);
			assert.deepEqual(observed.tokenOperations, []);
			assert.equal(JSON.parse(settingsText()).storage.secrets, undefined);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a failed settings write keeps the token file a join reused and records no cleanup failure",
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
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});

describe("team leave edge cases (#4320)", () => {
	test(
		"a leave without a settings file returns the empty result and creates no directory, lock or callback",
		async () => {
			const absent = join(root, "absent-agent");
			const lock = vi.spyOn(FileSettingsStorage.prototype, "withPrimaryWriteLock");
			const onLeft = vi.fn();

			const left = await leaveTeamWith(
				{ agentDir: absent, cwd: project },
				{ loadControl: async () => control, onLeft },
			);

			assert.deepEqual(left, {
				settingsPath: join(absent, "settings.json"),
				removed: [],
				kept: [],
				deletedTokenFiles: [],
				keptTokenFiles: [],
			});
			assert.equal(existsSync(absent), false);
			assert.equal(lock.mock.calls.length, 0);
			assert.equal(onLeft.mock.calls.length, 0);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a leave that removes nothing does not report a change",
		async () => {
			const custom = { theme: "dark", storage: { path: "shared.sqlite" } };
			writeFileSync(settingsPath, JSON.stringify(custom));
			const onLeft = vi.fn();

			const left = await leave(onLeft);

			assert.deepEqual(left.removed, []);
			assert.deepEqual(left.kept, [{ key: "storage", reason: "changed" }]);
			assert.equal(onLeft.mock.calls.length, 0);
			assert.deepEqual(JSON.parse(settingsText()), custom);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a leave whose settings write fails keeps the settings and the token file and reports nothing",
		async () => {
			const first = await joinTeamDatabase();
			assert.ok(first.tokenPath);
			const joined = settingsText();
			observed.tokenOperations = [];
			observed.settingsRenameFails = true;
			const onLeft = vi.fn();

			const failure = await leave(onLeft).then(
				() => assert.fail("left"),
				(error: Error) => error,
			);

			assert.ok(isTeamProfileError(failure));
			assert.equal(failure.code, "settings-write-failed");
			assert.equal(settingsText(), joined);
			assert.equal(existsSync(first.tokenPath), true);
			assert.deepEqual(observed.tokenOperations, []);
			assert.equal(onLeft.mock.calls.length, 0);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"removing the pin keeps the other keys of sessions",
		async () => {
			await joinTeamDatabase();
			const settings = JSON.parse(settingsText());
			writeFileSync(
				settingsPath,
				JSON.stringify({ ...settings, sessions: { ...settings.sessions, retained: { days: 7 } } }),
			);

			const left = await leave();

			assert.deepEqual(left.removed, ["storage", "sessions.storage"]);
			assert.deepEqual(JSON.parse(settingsText()).sessions, { retained: { days: 7 } });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a project settings file that cannot be parsed fails the leave as settings-unreadable before anything changes",
		async () => {
			const first = await joinTeamDatabase();
			assert.ok(first.tokenPath);
			const joined = settingsText();
			const projectSettings = join(project, ".atomic", "settings.json");
			mkdirSync(dirname(projectSettings), { recursive: true });
			writeFileSync(projectSettings, "{not json");
			const onLeft = vi.fn();

			const failure = await leave(onLeft).then(
				() => assert.fail("left"),
				(error: Error) => error,
			);

			assert.ok(isTeamProfileError(failure));
			assert.deepEqual([failure.code, failure.subject], ["settings-unreadable", projectSettings]);
			assert.equal(settingsText(), joined);
			assert.equal(existsSync(first.tokenPath), true);
			assert.equal(onLeft.mock.calls.length, 0);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"a trusted project whose storage lives only in a legacy config directory keeps the pin",
		async () => {
			await joinTeamDatabase();
			const legacy = join(project, ".pi", "settings.json");
			mkdirSync(dirname(legacy), { recursive: true });
			writeFileSync(
				legacy,
				JSON.stringify({ storage: { adapter: "@example/sessions", options: { url: "libsql://x.example.io" } } }),
			);
			new ProjectTrustStore(agentDir).set(project, true);

			const left = await leave();

			assert.deepEqual(left.removed, ["storage"]);
			assert.deepEqual(left.kept, [{ key: "sessions.storage", reason: "storage-remains" }]);
			assert.deepEqual(JSON.parse(settingsText()).sessions, { storage: LOCAL_SESSIONS_STORAGE });
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);

	test(
		"an unreadable independent project file fails a same-file leave as settings-unreadable before anything changes",
		async () => {
			agentDir = join(project, ".atomic");
			settingsPath = join(agentDir, "settings.json");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(settingsPath, JSON.stringify({ packages: [packageRoot] }));
			const first = await joinTeamDatabase();
			assert.ok(first.tokenPath);
			const joined = settingsText();
			const legacy = join(project, ".pi", "settings.json");
			mkdirSync(dirname(legacy), { recursive: true });
			writeFileSync(legacy, "{not json");

			const failure = await leave().then(
				() => assert.fail("left"),
				(error: Error) => error,
			);

			assert.ok(isTeamProfileError(failure));
			assert.deepEqual([failure.code, failure.subject], ["settings-unreadable", legacy]);
			assert.equal(settingsText(), joined);
			assert.equal(existsSync(first.tokenPath), true);
		},
		LIBSQL_SCENARIO_TIMEOUT_MS,
	);
});
