import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { DefaultSessionStoreOutcome } from "../fixtures/real-home-storage-guard/default-session-store.fixture.js";
import {
	CHILD_VITEST_TIMEOUT_MS,
	OPT_OUT_ENV,
	runGuardFixture,
} from "../fixtures/real-home-storage-guard/run-fixture.js";
import {
	failTestsThatTouchRealHome,
	foldsCase,
	installRealHomeStorageGuard,
	isRealHomeAccessError,
	protectedRootOf,
	RealHomeAccessError,
	RealHomeStorageOpenError,
	realHomeAtomicRoots,
	realHomeDirectories,
	sqliteLocationPath,
} from "../helpers/real-home-storage-guard.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

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

test("failTestsThatTouchRealHome checks the guard after each test and after the file's last one", () => {
	const registered: string[] = [];
	const checks: (() => void)[] = [];
	let checked = 0;
	failTestsThatTouchRealHome(
		{ assertNoViolations: () => checked++ },
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
	assert.ok(error instanceof RealHomeAccessError);
	assert.equal(error.name, "RealHomeStorageOpenError");
	assert.equal(error.code, "real-home-storage-open");
	assert.equal(error.path, "/home/u/.atomic/workflows/journal.sqlite");
	assert.equal(error.protectedRoot, "/home/u/.atomic");
	assert.equal(error.hint, fix);
	assert.equal(
		error.message,
		`Test opened a SQLite database under the real home directory: /home/u/.atomic/workflows/journal.sqlite (real-home-storage-open). ${fix}.`,
	);
});

describe("isRealHomeAccessError", () => {
	test("recognizes a guard's refusal, and a copy rebuilt from its name and code", () => {
		assert.equal(isRealHomeAccessError(new RealHomeStorageOpenError("/h/.atomic/j.sqlite", "/h/.atomic")), true);
		const copy = Object.assign(new Error("copied"), {
			name: "RealHomeStorageOpenError",
			code: "real-home-storage-open",
		});
		assert.equal(isRealHomeAccessError(copy), true);
		assert.equal(isRealHomeAccessError({ name: "RealHomeSettingsReadError", code: "real-home-settings-read" }), true);
	});

	test("rejects other errors, a name with another family code, and values that are not objects", () => {
		assert.equal(isRealHomeAccessError(new Error("plain")), false);
		assert.equal(isRealHomeAccessError({ name: "RealHomeStorageOpenError", code: "real-home-settings-read" }), false);
		assert.equal(isRealHomeAccessError({ name: "RealHomeStorageOpenError" }), false);
		assert.equal(isRealHomeAccessError({ code: "real-home-storage-open" }), false);
		assert.equal(isRealHomeAccessError(Object.assign(new Error("x"), { code: "real-home-storage-open" })), false);
		assert.equal(isRealHomeAccessError(null), false);
		assert.equal(isRealHomeAccessError(undefined), false);
		assert.equal(isRealHomeAccessError("RealHomeStorageOpenError"), false);
	});
});

test("foldsCase is true exactly for the platforms whose default filesystems ignore case", () => {
	assert.equal(foldsCase("win32"), true);
	assert.equal(foldsCase("darwin"), true);
	assert.equal(foldsCase("linux"), false);
});

describe("realHomeDirectories", () => {
	test("lists the OS home, HOME, USERPROFILE and HOMEDRIVE with HOMEPATH, each once", () => {
		assert.deepEqual(
			realHomeDirectories({ HOME: "/posix-home", USERPROFILE: "/profile", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\u" }),
			[homedir(), "/posix-home", "/profile", "C:\\Users\\u"],
		);
		assert.deepEqual(realHomeDirectories({ HOME: homedir(), USERPROFILE: homedir() }), [homedir()]);
	});
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

	test("lists a root once when two homes differ only by a trailing separator", () => {
		assert.deepEqual(realHomeAtomicRoots({ HOME: "/posix-home", USERPROFILE: "/posix-home/" }), [
			join(homedir(), ".atomic"),
			join("/posix-home", ".atomic"),
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

const SESSION_STORE_FIXTURE = "test/fixtures/real-home-storage-guard/default-session-store.fixture.ts";

test(
	"the shared test setup fails a test that opts out of its agent directory and opens the default store under the real home, even when the test catches it (#4445)",
	async () => {
		const home = join(scratch, "fixture-home");
		const journal = join(home, ".atomic", "workflows", "journal.sqlite");
		mkdirSync(home);

		const optedOut = await runGuardFixture<DefaultSessionStoreOutcome>(SESSION_STORE_FIXTURE, scratch, "opted-out", {
			HOME: home,
			USERPROFILE: home,
			[OPT_OUT_ENV]: "1",
		});
		assert.notEqual(optedOut.exitCode, 0, optedOut.output);
		assert.equal(optedOut.status, "failed", optedOut.output);
		assert.deepEqual(optedOut.outcome, {
			opened: false,
			failure: { name: "StorageUnavailableError", guardCode: "real-home-storage-open", guardPath: journal },
		});
		assert.match(optedOut.failure, /^RealHomeStorageOpenError: .*\(real-home-storage-open\)/u);
		assert.equal(existsSync(journal), false);
	},
	CHILD_VITEST_TIMEOUT_MS,
);

test(
	"the shared test setup opens a test's default store in an agent directory of its own, in place of an inherited real-home one (#4473)",
	async () => {
		const home = join(scratch, "default-home");
		const journal = join(home, ".atomic", "workflows", "journal.sqlite");
		const artifacts = join(scratch, "default-artifacts");
		mkdirSync(home);
		mkdirSync(artifacts);

		const run = await runGuardFixture<DefaultSessionStoreOutcome>(SESSION_STORE_FIXTURE, scratch, "default", {
			HOME: home,
			USERPROFILE: home,
			ATOMIC_WORKFLOW_ARTIFACT_DIR: artifacts,
			ATOMIC_CODING_AGENT_DIR: join(home, ".atomic", "agent"),
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		});
		assert.equal(run.exitCode, 0, run.output);
		assert.equal(run.status, "passed", run.output);
		const agentDir = run.outcome.agentDir ?? "";
		assert.match(relative(artifacts, agentDir), /^agent-home-[^/\\]+[/\\]\.atomic[/\\]agent$/u);
		assert.deepEqual(run.outcome, { opened: true, agentDir });
		assert.equal(existsSync(join(dirname(agentDir), "workflows", "journal.sqlite")), true);
		assert.equal(existsSync(journal), false);
	},
	CHILD_VITEST_TIMEOUT_MS,
);
