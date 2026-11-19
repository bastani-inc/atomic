import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tryAdvisoryLock } from "@bastani/atomic-natives";
import { afterEach, test, vi } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { ensureNamedWorktree, WorktreeReentryError } from "../../packages/subagents/src/runs/shared/named-worktree.js";
import { namedWorktreeLockDir } from "../helpers/named-worktree-locks.js";
import { bunExecutable, moduleDir, sleep, spawnSyncCollect } from "../helpers/runtime.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function posixPath(value: string): string {
	return value.replaceAll("\\", "/");
}

function git(repo: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", "-C", repo, ...args], { env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

function makeRepo(shared: boolean | "all" | "0001" | "0606" = false, umask?: "002"): { root: string; repo: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "named-worktree-locks-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(repo);
	if (umask !== undefined) {
		const result = spawnSyncCollect(
			["sh", "-c", 'umask "$1"; shift; exec "$@"', "sh", umask, "git", "-C", repo, "init", "-q", "-b", "main"],
			{ env: createGitEnvironment() },
		);
		assert.equal(result.exitCode, 0, result.stderr.toString());
	} else if (shared) git(repo, "init", "-q", "-b", "main", `--shared=${shared === true ? "group" : shared}`);
	else git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "config", "core.autocrlf", "false");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-q", "-m", "init");
	return { root, repo };
}

function targetLockPaths(
	repo: string,
	branch: string,
	worktreePath?: string,
): {
	dir: string;
	target: string;
	pathLock: string;
	branchLock: string;
} {
	const dir = namedWorktreeLockDir(repo);
	const target = worktreePath ?? join(repo, ".atomic", "worktrees", branch.replaceAll("/", "+"));
	const comparableTarget = process.platform === "win32" ? target.toLowerCase() : target;
	const comparableBranch = process.platform === "win32" ? branch.toLowerCase() : branch;
	const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
	return {
		dir,
		target,
		pathLock: join(dir, `path-${hash(comparableTarget)}.lock`),
		branchLock: join(dir, `branch-${hash(comparableBranch)}.lock`),
	};
}

test("checking out an existing branch does not put Atomic locks in refs or objects/info", async () => {
	const { root, repo } = makeRepo();
	git(repo, "branch", "existing");
	const dirs = [join(repo, ".git", "objects", "info"), join(repo, ".git", "refs")];
	const before = dirs.map((dir) => readdirSync(dir).sort());
	if (process.platform !== "win32")
		for (const dir of dirs) {
			chmodSync(dir, 0o555);
			cleanups.push(() => chmodSync(dir, 0o755));
		}
	const checkout = await ensureNamedWorktree(repo, { branch: "existing", path: join(root, "outside") });
	assert.equal(git(checkout.path, "branch", "--show-current"), "existing");
	assert.deepEqual(
		dirs.map((dir) => readdirSync(dir).sort()),
		before,
	);
});

test("malformed ATOMIC_NAMED_WORKTREE_LOCKS values are treated as empty so launches succeed (#5202)", async () => {
	const { repo } = makeRepo();
	for (const [index, value] of ["x", "{}", "[1]"].entries()) {
		vi.stubEnv("ATOMIC_NAMED_WORKTREE_LOCKS", value);
		const branch = `feat/env-${index}`;
		const created = await ensureNamedWorktree(repo, { branch });
		assert.equal(git(created.path, "branch", "--show-current"), branch);
	}
});

test("a checkout hook can create an unrelated named worktree while refusing active same-target reentry and allowing delayed background launches after the hook returns (#5202)", async () => {
	const { root, repo } = makeRepo();
	const outerLocks = targetLockPaths(repo, "feat/outer");
	mkdirSync(outerLocks.dir, { recursive: true });
	const heldOuterPath = tryAdvisoryLock(outerLocks.pathLock, 0);
	const heldOuterBranch = tryAdvisoryLock(outerLocks.branchLock, 0);
	assert.ok(heldOuterPath);
	assert.ok(heldOuterBranch);
	vi.stubEnv("ATOMIC_NAMED_WORKTREE_LOCKS", JSON.stringify([outerLocks.pathLock, outerLocks.branchLock]));
	try {
		const unrelated = await ensureNamedWorktree(repo, {
			branch: "feat/unrelated-nested",
			path: join(root, "unrelated-nested"),
		});
		assert.equal(git(unrelated.path, "branch", "--show-current"), "feat/unrelated-nested");

		await assert.rejects(
			ensureNamedWorktree(repo, { branch: "feat/outer", path: join(root, "same-branch-nested") }),
			(error: Error) => {
				assert.ok(error instanceof WorktreeReentryError);
				assert.ok(error.message.includes(join(root, "same-branch-nested")));
				return true;
			},
		);

		await assert.rejects(
			ensureNamedWorktree(repo, { branch: "feat/same-path-nested", path: outerLocks.target }),
			(error: Error) => {
				assert.ok(error instanceof WorktreeReentryError);
				assert.ok(error.message.includes(outerLocks.target));
				return true;
			},
		);
	} finally {
		heldOuterBranch.release();
		heldOuterPath.release();
	}

	const afterOuterRelease = await ensureNamedWorktree(repo, { branch: "feat/outer" });
	assert.equal(afterOuterRelease.path, outerLocks.target);
	assert.equal(git(afterOuterRelease.path, "branch", "--show-current"), "feat/outer");

	vi.unstubAllEnvs();
	const hookResultFile = join(root, "hook-nested-result.json");
	const outerReturnedFile = join(root, "hook-outer-returned");
	const bgResultFile = join(root, "hook-bg-result.json");
	const hookScript = join(root, "hook-nested.mjs");
	const bgScript = join(root, "hook-bg.mjs");
	const moduleUrl = pathToFileURL(
		join(moduleDir(import.meta.url), "../../packages/subagents/src/runs/shared/named-worktree.ts"),
	).href;
	writeFileSync(
		hookScript,
		`import { writeFileSync } from "node:fs";
const [moduleUrl, repo, nestedPath, sameBranchPath, outFile] = process.argv.slice(2);
const { ensureNamedWorktree, WorktreeReentryError } = await import(moduleUrl);
const created = await ensureNamedWorktree(repo, { branch: "feat/from-hook", path: nestedPath });
let refused = false;
try {
	await ensureNamedWorktree(repo, { branch: "feat/hook-outer", path: sameBranchPath });
} catch (error) {
	refused = error instanceof WorktreeReentryError;
}
writeFileSync(outFile, JSON.stringify({ createdPath: created.path, refused }));
`,
	);
	writeFileSync(
		bgScript,
		`import { existsSync, renameSync, writeFileSync } from "node:fs";
const [moduleUrl, repo, readyFile, outFile] = process.argv.slice(2);
const { ensureNamedWorktree } = await import(moduleUrl);
const deadline = Date.now() + 10_000;
while (!existsSync(readyFile) && Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 25));
}
let payload;
try {
	const reused = await ensureNamedWorktree(repo, { branch: "feat/hook-outer" });
	payload = { ok: true, reusedPath: reused.path, pid: process.pid };
} catch (error) {
	payload = {
		ok: false,
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
		pid: process.pid,
	};
}
const tempFile = \`\${outFile}.tmp\`;
writeFileSync(tempFile, JSON.stringify(payload));
renameSync(tempFile, outFile);
`,
	);
	const hooksDir = join(repo, ".git", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const postCheckout = join(hooksDir, "post-checkout");
	const marker = join(root, "hook-ran");
	writeFileSync(
		postCheckout,
		`#!/bin/sh\n[ -e "${posixPath(marker)}" ] && exit 0\necho 1 > "${posixPath(marker)}"\ncd "${posixPath(tmpdir())}" || exit 1\n"${posixPath(bunExecutable())}" "${posixPath(hookScript)}" "${moduleUrl}" "${posixPath(repo)}" "${posixPath(join(root, "from-hook"))}" "${posixPath(join(root, "hook-conflict"))}" "${posixPath(hookResultFile)}"\n"${posixPath(bunExecutable())}" "${posixPath(bgScript)}" "${moduleUrl}" "${posixPath(repo)}" "${posixPath(outerReturnedFile)}" "${posixPath(bgResultFile)}" >/dev/null 2>&1 &\n`,
	);
	chmodSync(postCheckout, 0o755);

	const outer = await ensureNamedWorktree(repo, { branch: "feat/hook-outer" });
	writeFileSync(outerReturnedFile, "1");
	assert.equal(git(outer.path, "branch", "--show-current"), "feat/hook-outer");
	const hookOutcome = JSON.parse(fs.readFileSync(hookResultFile, "utf8")) as {
		createdPath: string;
		refused: boolean;
	};
	assert.equal(hookOutcome.createdPath, join(root, "from-hook"));
	assert.equal(git(hookOutcome.createdPath, "branch", "--show-current"), "feat/from-hook");
	assert.equal(hookOutcome.refused, true);

	const BG_LAUNCH_WAIT_MS = 10_000;
	const bgDeadline = performance.now() + BG_LAUNCH_WAIT_MS;
	while (!fs.existsSync(bgResultFile) && performance.now() < bgDeadline) {
		await sleep(25);
	}
	assert.equal(fs.existsSync(bgResultFile), true, "expected background launch from post-checkout hook to finish");
	const bgOutcome = JSON.parse(fs.readFileSync(bgResultFile, "utf8")) as {
		ok: boolean;
		reusedPath?: string;
		name?: string;
		message?: string;
		pid: number;
	};
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(bgOutcome.pid, 0);
			await sleep(25);
		} catch {
			break;
		}
	}
	assert.equal(bgOutcome.ok, true, `background launch failed: ${bgOutcome.name}: ${bgOutcome.message}`);
	assert.equal(bgOutcome.reusedPath, outer.path);
});

test("a launch waiting on a busy branch lock releases its path lock so an unrelated branch at that path proceeds without waiting (#5202)", async () => {
	const { root, repo } = makeRepo();
	const sharedPath = join(root, "p1");
	const otherPath = join(root, "p2");
	await ensureNamedWorktree(repo, { branch: "feat/slow", path: otherPath });

	const slowLocks = targetLockPaths(repo, "feat/slow", otherPath);
	const heldBranchLock = tryAdvisoryLock(slowLocks.branchLock, 0);
	assert.ok(heldBranchLock);

	const UNRELATED_LOCK_RELEASE_WATCHDOG_MS = 6_000;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	const waiter = ensureNamedWorktree(repo, { branch: "feat/slow", path: sharedPath }).then(
		() => ({ ok: true as const, message: "" }),
		(error: Error) => ({ ok: false as const, message: error.message }),
	);

	try {
		await sleep(250);
		watchdog = setTimeout(() => heldBranchLock.release(), UNRELATED_LOCK_RELEASE_WATCHDOG_MS);
		const started = performance.now();
		const unrelated = await ensureNamedWorktree(repo, { branch: "feat/fast", path: sharedPath });
		const elapsed = performance.now() - started;
		assert.equal(unrelated.path, sharedPath);
		assert.equal(git(unrelated.path, "branch", "--show-current"), "feat/fast");
		assert.ok(elapsed < 5_000, `unrelated launch at shared path took ${Math.round(elapsed)}ms`);
	} finally {
		clearTimeout(watchdog);
		heldBranchLock.release();
	}

	const waiterOutcome = await waiter;
	assert.equal(waiterOutcome.ok, false);
	assert.match(waiterOutcome.message, /branch "feat\/slow" is already checked out at /);
});

test.skipIf(process.platform === "win32")(
	"group-shared repositories create 2770 lock directories and 0660 lock files without chmodding existing lock directories (#5202)",
	async () => {
		const { root, repo } = makeRepo(true);
		const wts = join(root, "wts");
		mkdirSync(wts);
		chmodSync(wts, 0o2775);

		const first = await ensureNamedWorktree(repo, { branch: "feat/shared-a", path: join(wts, "shared-a") });
		assert.equal(git(first.path, "branch", "--show-current"), "feat/shared-a");

		const lockDir = namedWorktreeLockDir(repo);
		assert.equal(statSync(lockDir).mode & 0o2777, 0o2770);
		const files = readdirSync(lockDir).filter((name) => name.endsWith(".lock"));
		assert.equal(files.length, 2);
		for (const file of files) {
			assert.equal(statSync(join(lockDir, file)).mode & 0o777, 0o660, file);
		}

		chmodSync(lockDir, 0o2775);
		const second = await ensureNamedWorktree(repo, { branch: "feat/shared-b", path: join(wts, "shared-b") });
		assert.equal(git(second.path, "branch", "--show-current"), "feat/shared-b");
		assert.equal(
			statSync(lockDir).mode & 0o2777,
			0o2775,
			"existing lock directory permissions are preserved without chmod",
		);
		chmodSync(lockDir, 0o2770);

		const uid = process.getuid?.();
		const gid = process.getgid?.();
		let canChownOtherUid = false;
		if (uid !== undefined && uid !== 0 && gid !== undefined) {
			try {
				canChownOtherUid = spawnSyncCollect(["sudo", "-n", "chown", "-R", `54321:${gid}`, lockDir]).exitCode === 0;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
		if (canChownOtherUid) {
			cleanups.push(() => {
				spawnSyncCollect(["sudo", "-n", "rm", "-rf", root]);
			});
			assert.equal(statSync(lockDir).uid, 54321);
			const reused = await ensureNamedWorktree(repo, { branch: "feat/shared-a", path: join(wts, "shared-a") });
			assert.equal(reused.path, first.path);
			const third = await ensureNamedWorktree(repo, {
				branch: "feat/shared-user-b",
				path: join(wts, "shared-user-b"),
			});
			assert.equal(git(third.path, "branch", "--show-current"), "feat/shared-user-b");
		}

		const { root: rootAll, repo: repoAll } = makeRepo("all");
		await ensureNamedWorktree(repoAll, { branch: "feat/shared-all", path: join(rootAll, "shared-all") });
		const lockDirAll = namedWorktreeLockDir(repoAll);
		assert.equal(statSync(lockDirAll).mode & 0o2777, 0o2770);
		for (const file of readdirSync(lockDirAll).filter((name) => name.endsWith(".lock"))) {
			assert.equal(statSync(join(lockDirAll, file)).mode & 0o777, 0o660, file);
		}
	},
);

for (const [setting, expectedDirMode, expectedFileMode] of [
	["0001", 0o2770, 0o660],
	["0606", 0o707, 0o606],
] as const) {
	test.skipIf(process.platform === "win32")(
		`Git sharing setting ${setting} keeps the same writers on checkout locks (#5202)`,
		async () => {
			const { root, repo } = makeRepo(setting);
			git(repo, "config", "core.sharedRepository", setting);
			await ensureNamedWorktree(repo, { branch: "feat/shared-setting", path: join(root, "shared-setting") });
			const lockDir = namedWorktreeLockDir(repo);
			assert.equal(statSync(lockDir).mode & 0o2777, expectedDirMode);
			assert.equal(statSync(lockDir).gid, statSync(join(repo, ".git", "objects", "info")).gid);
			for (const file of readdirSync(lockDir).filter((name) => name.endsWith(".lock"))) {
				assert.equal(statSync(join(lockDir, file)).mode & 0o777, expectedFileMode);
			}
		},
	);
}

for (const setting of [undefined, "umask"]) {
	test.skipIf(process.platform === "win32")(
		`a repository initialized with umask 002 shares checkout locks with core.sharedRepository ${setting ?? "unset"} (#5202)`,
		async () => {
			const { root, repo } = makeRepo(false, "002");
			assert.equal(statSync(join(repo, ".git", "objects", "info")).mode & 0o777, 0o775);
			if (setting !== undefined) git(repo, "config", "core.sharedRepository", setting);
			await ensureNamedWorktree(repo, { branch: "feat/shared-umask", path: join(root, "shared-umask") });
			const lockDir = namedWorktreeLockDir(repo);
			assert.equal(statSync(lockDir).mode & 0o2777, 0o2770);
			assert.equal(statSync(lockDir).gid, statSync(join(repo, ".git", "objects", "info")).gid);
			for (const file of readdirSync(lockDir).filter((name) => name.endsWith(".lock"))) {
				assert.equal(statSync(join(lockDir, file)).mode & 0o777, 0o660);
			}
		},
	);
}

test.skipIf(process.platform === "win32")(
	"read-only objects/info or objects directories fall back to a writable lock directory outside worktrees, and unreadable lock files name the lock path (#5202)",
	async () => {
		const { root: rootInfoRo, repo: repoInfoRo } = makeRepo();
		const infoDir = join(repoInfoRo, ".git", "objects", "info");
		chmodSync(infoDir, 0o555);
		cleanups.push(() => chmodSync(infoDir, 0o755));

		const fromInfoRo = await ensureNamedWorktree(repoInfoRo, {
			branch: "feat/info-ro",
			path: join(rootInfoRo, "wt-info-ro"),
		});
		assert.equal(git(fromInfoRo.path, "branch", "--show-current"), "feat/info-ro");
		assert.doesNotMatch(git(repoInfoRo, "worktree", "list", "--porcelain"), /atomic-named-worktree-locks/);

		const infoRoFallbackDir = targetLockPaths(repoInfoRo, "feat/info-ro").dir;
		cleanups.push(() => rmSync(infoRoFallbackDir, { recursive: true, force: true }));
		const recoveredTarget = join(rootInfoRo, "wt-info-recovered");
		const recoveredPathLock = join(
			infoRoFallbackDir,
			`path-${createHash("sha256").update(recoveredTarget).digest("hex")}.lock`,
		);
		const heldFallbackLock = tryAdvisoryLock(recoveredPathLock, 0);
		assert.ok(heldFallbackLock);
		chmodSync(infoDir, 0o755);
		const abortRecovered = new AbortController();
		let sawWaitingAfterRecovery = false;
		const queuedAfterRecovery = ensureNamedWorktree(
			repoInfoRo,
			{ branch: "feat/info-recovered", path: recoveredTarget },
			{
				signal: abortRecovered.signal,
				onWaiting: (message) => {
					if (message) {
						sawWaitingAfterRecovery = true;
						abortRecovered.abort(new Error("still serialized on fallback lock"));
					}
				},
			},
		).then(
			() => "created",
			(error: Error) => error.message,
		);
		try {
			assert.match(await queuedAfterRecovery, /still serialized on fallback lock/);
			assert.equal(sawWaitingAfterRecovery, true);
		} finally {
			abortRecovered.abort();
			heldFallbackLock.release();
		}

		const { root: rootObjectsRo, repo: repoObjectsRo } = makeRepo();
		git(repoObjectsRo, "worktree", "add", "-q", "-b", "seed", join(rootObjectsRo, "seed"));
		rmSync(join(repoObjectsRo, ".git", "objects", "info"), { recursive: true, force: true });
		chmodSync(join(repoObjectsRo, ".git", "objects"), 0o555);
		chmodSync(join(repoObjectsRo, ".git"), 0o555);
		cleanups.push(() => {
			chmodSync(join(repoObjectsRo, ".git"), 0o755);
			chmodSync(join(repoObjectsRo, ".git", "objects"), 0o755);
		});

		const fromObjectsRo = await ensureNamedWorktree(repoObjectsRo, {
			branch: "feat/objects-ro",
			path: join(rootObjectsRo, "wt-objects-ro"),
		});
		assert.equal(git(fromObjectsRo.path, "branch", "--show-current"), "feat/objects-ro");

		const { repo: repoLockRo } = makeRepo();
		await ensureNamedWorktree(repoLockRo, { branch: "feat/lock-ro" });
		const { pathLock } = targetLockPaths(repoLockRo, "feat/lock-ro");
		chmodSync(pathLock, 0o400);
		cleanups.push(() => chmodSync(pathLock, 0o600));

		await assert.rejects(ensureNamedWorktree(repoLockRo, { branch: "feat/lock-ro" }), (error: Error) => {
			assert.ok(error.message.includes(pathLock), `expected lock path ${pathLock} in: ${error.message}`);
			assert.equal((error.message.match(/\(os error \d+\)/g) ?? []).length, 1, error.message);
			return true;
		});

		const { root: rootUnsafeFallback, repo: repoUnsafeFallback } = makeRepo();
		const unsafeFallbackDir = targetLockPaths(repoUnsafeFallback, "feat/unsafe-fallback").dir;
		mkdirSync(unsafeFallbackDir, { recursive: true });
		chmodSync(unsafeFallbackDir, 0o777);
		cleanups.push(() => rmSync(unsafeFallbackDir, { recursive: true, force: true }));
		const unsafeInfoDir = join(repoUnsafeFallback, ".git", "objects", "info");
		chmodSync(unsafeInfoDir, 0o555);
		cleanups.push(() => chmodSync(unsafeInfoDir, 0o755));

		await assert.rejects(
			ensureNamedWorktree(repoUnsafeFallback, {
				branch: "feat/unsafe-fallback",
				path: join(rootUnsafeFallback, "wt-unsafe"),
			}),
			(error: Error) => {
				assert.ok(error.message.includes(unsafeFallbackDir), error.message);
				assert.match(error.message, /world-writable/);
				return true;
			},
		);
	},
);
