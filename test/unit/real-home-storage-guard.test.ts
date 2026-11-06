import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { repositoryRoot } from "../../vitest.base.js";
import type { DefaultSessionStoreOutcome } from "../fixtures/real-home-storage-guard/default-session-store.fixture.js";
import {
	failTestsThatOpenRealHomeStorage,
	foldsCase,
	installRealHomeStorageGuard,
	protectedRootOf,
	RealHomeStorageOpenError,
	realHomeAtomicRoots,
	sqliteLocationPath,
} from "../helpers/real-home-storage-guard.js";
import { makeTempDirectory, readJson, readStreamText, removeTempDirectory, spawnProcess } from "../helpers/runtime.js";

const scratch = makeTempDirectory("atomic-real-home-guard-");
afterAll(() => removeTempDirectory(scratch));

function isGuardRejection(path: string, root: string) {
	return (error: RealHomeStorageOpenError) => {
		assert.ok(error instanceof RealHomeStorageOpenError);
		assert.equal(error.code, "real-home-storage-open");
		assert.equal(error.path, path);
		assert.equal(error.protectedRoot, root);
		return true;
	};
}

describe("sqliteLocationPath", () => {
	test("returns a plain path as written and nothing for an in-memory database", () => {
		assert.equal(sqliteLocationPath("/home/u/.atomic/journal.sqlite"), "/home/u/.atomic/journal.sqlite");
		assert.equal(sqliteLocationPath("journal.sqlite"), "journal.sqlite");
		assert.equal(sqliteLocationPath(":memory:"), undefined);
		assert.equal(sqliteLocationPath(""), undefined);
	});

	test("reads the file a SQLite URI filename, file URL or Buffer names", () => {
		assert.equal(sqliteLocationPath("file:/home/u/journal.sqlite?mode=ro#part"), "/home/u/journal.sqlite");
		assert.equal(sqliteLocationPath("file://localhost/home/u/a%20b.sqlite"), "/home/u/a b.sqlite");
		assert.equal(sqliteLocationPath("file:///C:/Users/u/journal.sqlite"), "C:/Users/u/journal.sqlite");
		assert.equal(sqliteLocationPath("file:/data/c:/journal.sqlite"), "/data/c:/journal.sqlite");
		assert.equal(sqliteLocationPath("file:relative//journal.sqlite"), "relative//journal.sqlite");
		const absolute = join(scratch, "url.sqlite");
		assert.equal(sqliteLocationPath(pathToFileURL(absolute)), absolute);
		assert.equal(sqliteLocationPath(new URL("https://example.test/journal.sqlite")), undefined);
		assert.equal(sqliteLocationPath(Buffer.from("/home/u/journal.sqlite")), "/home/u/journal.sqlite");
	});
});

test("failTestsThatOpenRealHomeStorage checks the guard after each test and after the file's last one", () => {
	const registered: string[] = [];
	const checks: (() => void)[] = [];
	let checked = 0;
	failTestsThatOpenRealHomeStorage(
		{ roots: [], assertNoViolations: () => checked++ },
		{
			afterEach: (check) => {
				registered.push("afterEach");
				checks.push(check);
			},
			afterAll: (check) => {
				registered.push("afterAll");
				checks.push(check);
			},
		},
	);
	assert.deepEqual(registered, ["afterEach", "afterAll"]);
	for (const check of checks) check();
	assert.equal(checked, 2);
});

test("RealHomeStorageOpenError names the opened path, its code and the fix", () => {
	const fix =
		"Give the test its own agent directory: point ATOMIC_CODING_AGENT_DIR at a temporary directory, or pass the store an explicit temporary path";
	const error = new RealHomeStorageOpenError("/home/u/.atomic/workflows/journal.sqlite", "/home/u/.atomic");
	assert.equal(error.name, "RealHomeStorageOpenError");
	assert.equal(error.hint, fix);
	assert.equal(
		error.message,
		`Test opened a SQLite database under the real home directory: /home/u/.atomic/workflows/journal.sqlite (real-home-storage-open). ${fix}.`,
	);
});

test("foldsCase is true exactly for the platforms whose default filesystems ignore case", () => {
	assert.equal(foldsCase("win32"), true);
	assert.equal(foldsCase("darwin"), true);
	assert.equal(foldsCase("linux"), false);
});

describe("realHomeAtomicRoots", () => {
	test("covers the OS home, HOME, USERPROFILE and HOMEDRIVE with HOMEPATH", () => {
		assert.deepEqual(
			realHomeAtomicRoots({ HOME: "/posix-home", USERPROFILE: "/profile", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\u" }),
			[
				join(homedir(), ".atomic"),
				join("/posix-home", ".atomic"),
				join("/profile", ".atomic"),
				join("C:\\Users\\u", ".atomic"),
			],
		);
	});

	test("skips unset and empty homes and lists each home once", () => {
		assert.deepEqual(realHomeAtomicRoots({ HOME: "", HOMEDRIVE: "C:" }), [join(homedir(), ".atomic")]);
		assert.deepEqual(realHomeAtomicRoots({ HOMEPATH: "\\Users\\u", USERPROFILE: homedir() }), [
			join(homedir(), ".atomic"),
		]);
	});
});

describe("protectedRootOf", () => {
	const home = join(scratch, "home");
	const root = join(home, ".atomic");
	beforeAll(() => mkdirSync(join(root, "workflows"), { recursive: true }));

	test("matches the root, anything below it and paths that only normalize into it", () => {
		assert.equal(protectedRootOf(join(root, "workflows", "journal.sqlite"), [root]), root);
		assert.equal(protectedRootOf(join(root, "missing", "nested", "journal.sqlite"), [root]), root);
		assert.equal(protectedRootOf(join(root, "..journal.sqlite"), [root]), root);
		assert.equal(protectedRootOf(root, [root]), root);
		assert.equal(protectedRootOf(join(home, "other", "..", ".atomic", "journal.sqlite"), [root]), root);
		assert.equal(protectedRootOf(`file:${join(root, "journal.sqlite")}?mode=ro`, ["/unrelated", root]), root);
	});

	test("leaves the home itself, siblings, escapes and in-memory databases alone", () => {
		assert.equal(protectedRootOf(home, [root]), undefined);
		assert.equal(protectedRootOf(join(home, "journal.sqlite"), [root]), undefined);
		assert.equal(protectedRootOf(join(home, ".atomic-other", "journal.sqlite"), [root]), undefined);
		assert.equal(protectedRootOf(join(root, "..", "journal.sqlite"), [root]), undefined);
		assert.equal(protectedRootOf(":memory:", [root]), undefined);
	});

	test("compares without case only on platforms that fold it", () => {
		const absentRoot = join(scratch, "absent-home", ".atomic");
		const shouted = join(scratch, "absent-home", ".ATOMIC", "journal.sqlite");
		assert.equal(protectedRootOf(shouted, [absentRoot], "win32"), absentRoot);
		assert.equal(protectedRootOf(shouted, [absentRoot], "linux"), undefined);
	});

	test("sees through a symlinked home in either direction, including to files that do not exist yet", () => {
		const realHome = join(scratch, "real-home");
		const aliasHome = join(scratch, "alias-home");
		mkdirSync(join(realHome, ".atomic"), { recursive: true });
		symlinkSync(realHome, aliasHome, "junction");
		const viaReal = join(realHome, ".atomic", "workflows", "journal.sqlite");
		const viaAlias = join(aliasHome, ".atomic", "workflows", "journal.sqlite");
		assert.equal(protectedRootOf(viaReal, [join(aliasHome, ".atomic")]), join(aliasHome, ".atomic"));
		assert.equal(protectedRootOf(viaAlias, [join(realHome, ".atomic")]), join(realHome, ".atomic"));
	});
});

describe("installRealHomeStorageGuard", () => {
	const home = join(scratch, "guarded-home");
	const root = join(home, ".atomic");
	const journal = join(root, "workflows", "journal.sqlite");

	test("the path opens normally until the guard protects its root", () => {
		mkdirSync(dirname(journal), { recursive: true });
		new DatabaseSync(journal).close();
		assert.equal(existsSync(journal), true);
		rmSync(journal);
	});

	describe("once its root is protected", () => {
		let guard: ReturnType<typeof installRealHomeStorageGuard>;
		beforeAll(() => {
			guard = installRealHomeStorageGuard([root]);
		});

		test("rejects every form of the path before SQLite creates the file", async () => {
			const { DatabaseSync: loadedLater } = await import("node:sqlite");
			assert.throws(() => new DatabaseSync(journal), isGuardRejection(journal, root));
			assert.throws(() => new loadedLater(pathToFileURL(journal)), isGuardRejection(journal, root));
			assert.throws(() => new loadedLater(`file:${journal}?mode=rwc`), isGuardRejection(journal, root));
			assert.equal(existsSync(journal), false);
			assert.throws(() => guard.assertNoViolations(), AggregateError);
		});

		test("fails the check once for a rejection the caller caught, then starts clean", () => {
			assert.throws(() => new DatabaseSync(journal), RealHomeStorageOpenError);
			assert.throws(() => guard.assertNoViolations(), isGuardRejection(journal, root));
			guard.assertNoViolations();
		});

		test("reports several rejections together", () => {
			const other = join(root, "storage.sqlite");
			assert.throws(() => new DatabaseSync(journal), RealHomeStorageOpenError);
			assert.throws(() => new DatabaseSync(other), RealHomeStorageOpenError);
			assert.throws(
				() => guard.assertNoViolations(),
				(error: AggregateError) => {
					assert.ok(error instanceof AggregateError);
					assert.equal(error.message, "2 real-home SQLite opens were rejected");
					assert.deepEqual(
						error.errors.map((rejection: RealHomeStorageOpenError) => [rejection.code, rejection.path]),
						[
							["real-home-storage-open", journal],
							["real-home-storage-open", other],
						],
					);
					return true;
				},
			);
		});

		test("rejects the session store's default database under the protected home", async () => {
			await assert.rejects(
				resolveSessionStore(scratch, { agentDir: join(root, "agent"), settings: {} }),
				(error: StorageUnavailableError) => {
					assert.ok(error instanceof StorageUnavailableError);
					return isGuardRejection(journal, root)(error.cause as RealHomeStorageOpenError);
				},
			);
			assert.equal(existsSync(journal), false);
			assert.throws(() => guard.assertNoViolations(), RealHomeStorageOpenError);
		});

		test("leaves databases elsewhere and in memory working", async () => {
			const database = await openNodeSqliteDatabase(join(scratch, "elsewhere", "journal.sqlite"));
			try {
				assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
			} finally {
				await database.close();
			}
			const memory = new DatabaseSync(":memory:");
			assert.deepEqual({ ...memory.prepare("SELECT 2 AS two").get() }, { two: 2 });
			memory.close();
			guard.assertNoViolations();
		});

		test("installing again adds new roots to the guard the shared setup installed, once each", () => {
			const other = join(scratch, "other-home", ".atomic");
			const again = installRealHomeStorageGuard([root, other, other]);
			assert.equal(again, guard);
			assert.deepEqual(again.roots, [...realHomeAtomicRoots(), root, other]);
			assert.throws(
				() => new DatabaseSync(join(other, "journal.sqlite")),
				isGuardRejection(join(other, "journal.sqlite"), other),
			);
			assert.throws(() => guard.assertNoViolations(), RealHomeStorageOpenError);
		});
	});
});

/**
 * Structural: the test starts two real vitest processes, each transforming the session storage module graph before
 * its fixture runs. Named and kept at the call site, per the per-test timeout policy in AGENTS.md.
 */
const CHILD_VITEST_TIMEOUT_MS = 120_000;

interface FixtureRun {
	readonly exitCode: number;
	readonly output: string;
	readonly status: string;
	readonly outcome: DefaultSessionStoreOutcome;
}

async function runDefaultSessionStoreFixture(name: string, env: Record<string, string>): Promise<FixtureRun> {
	const report = join(scratch, `${name}-report.json`);
	const outcomeFile = join(scratch, `${name}-outcome.json`);
	const child = spawnProcess(
		[
			process.execPath,
			join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
			"--run",
			"--config",
			join(repositoryRoot, "test", "fixtures", "real-home-storage-guard", "vitest.config.ts"),
			"--reporter=json",
			"--outputFile",
			report,
		],
		{
			cwd: repositoryRoot,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: undefined,
				PI_CODING_AGENT_DIR: undefined,
				ATOMIC_CODING_AGENT_SESSION_DIR: undefined,
				PI_CODING_AGENT_SESSION_DIR: undefined,
				ATOMIC_SESSIONS_STORAGE: undefined,
				ATOMIC_STORAGE: undefined,
				ATOMIC_PROFILE: undefined,
				REAL_HOME_GUARD_FIXTURE_OUTCOME: outcomeFile,
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		readStreamText(child.stdout),
		readStreamText(child.stderr),
		child.exited,
	]);
	const output = stdout + stderr;
	const results = await readJson<{ testResults: { assertionResults: { status: string }[] }[] }>(report);
	return {
		exitCode,
		output,
		status: results.testResults[0]?.assertionResults[0]?.status ?? "missing",
		outcome: await readJson<DefaultSessionStoreOutcome>(outcomeFile),
	};
}

test(
	"the shared test setup fails a test whose default store opens under the real home, even when the test catches it (#4445)",
	async () => {
		const home = join(scratch, "fixture-home");
		const journal = join(home, ".atomic", "workflows", "journal.sqlite");
		mkdirSync(home);

		const guarded = await runDefaultSessionStoreFixture("guarded", { HOME: home, USERPROFILE: home });
		assert.notEqual(guarded.exitCode, 0, guarded.output);
		assert.equal(guarded.status, "failed", guarded.output);
		assert.deepEqual(guarded.outcome, {
			opened: false,
			failure: { name: "StorageUnavailableError", guardCode: "real-home-storage-open", guardPath: journal },
		});
		assert.equal(existsSync(journal), false);

		const agentHome = join(scratch, "fixture-agent-home");
		const remedied = await runDefaultSessionStoreFixture("remedied", {
			HOME: home,
			USERPROFILE: home,
			ATOMIC_CODING_AGENT_DIR: join(agentHome, ".atomic", "agent"),
		});
		assert.equal(remedied.exitCode, 0, remedied.output);
		assert.equal(remedied.status, "passed", remedied.output);
		assert.deepEqual(remedied.outcome, { opened: true });
		assert.equal(existsSync(join(agentHome, ".atomic", "workflows", "journal.sqlite")), true);
		assert.equal(existsSync(journal), false);
	},
	CHILD_VITEST_TIMEOUT_MS,
);
