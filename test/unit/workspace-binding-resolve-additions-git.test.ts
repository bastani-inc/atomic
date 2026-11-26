import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, onTestFinished, test } from "vitest";
import {
	assertWorkspaceGitAvailable,
	observeWorkspaceGitCommands,
	runWorkspaceGit,
	setWorkspaceGitExecutableResolver,
} from "../../packages/coding-agent/src/core/workspace/git.js";
import {
	GitUnavailableError,
	isGitUnavailableError,
	isWorkspaceBindingError,
	isWorkspaceTimeoutError,
	resolveWorkspace,
	restoreWorkspace,
	WorkspaceBindingError,
	workspace,
	workspaceChangeSet,
} from "../../packages/coding-agent/src/core/workspace/index.js";
import { withRepositoryLock } from "../../packages/coding-agent/src/core/workspace/lease.js";
import {
	runWorkspaceProcess,
	WORKSPACE_PROCESS_STOP_GRACE_MS,
} from "../../packages/coding-agent/src/core/workspace/process.js";
import {
	setWorktreeAdditionWait,
	sharedStorePath,
	verifyWorktree,
	WORKTREE_ADDING_REASON,
	worktreeAdderRecord,
} from "../../packages/coding-agent/src/core/workspace/resolve.js";
import { classifyRepository } from "../../packages/coding-agent/src/core/workspace/spec.js";
import { keepProcessPid } from "../helpers/exited-process.js";
import {
	commitFile,
	countGitCommands,
	createRemote,
	createRepository,
	git,
	gitTranscript,
	interruptedWorktree,
	recordExitedAdder,
	type WorkspaceSandboxDirs,
	withInjectedGit,
	workspaceSandbox,
} from "../helpers/workspace-repos.js";
import { rejection, SHA } from "./workspace-binding-resolve-helpers.js";

let dirs: WorkspaceSandboxDirs;
let restoreAdditionWait: () => void;

beforeEach(() => {
	dirs = workspaceSandbox("atomic-workspace-resolve-");
	restoreAdditionWait = setWorktreeAdditionWait({ probes: 3, intervalMs: 10 });
});

afterEach(() => {
	restoreAdditionWait();
	dirs.cleanup();
});

describe("workspace git runner (#3109)", () => {
	test("reports a missing git as git-unavailable caused by GitUnavailableError, after one attempt and no writes (#3109)", async () => {
		const restore = setWorkspaceGitExecutableResolver(async () => ({
			path: join(dirs.root, "no-such-git"),
			env: {},
		}));
		try {
			const remote = createRemote(dirs.root, "needs-git");
			const { result, commands } = await countGitCommands(() =>
				rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
			);
			assert.ok(isWorkspaceBindingError(result));
			assert.equal(result.code, "git-unavailable");
			assert.ok(isGitUnavailableError(result.cause));
			assert.ok(result.cause instanceof GitUnavailableError);
			assert.equal(result.cause.code, "not-installed");
			assert.equal(result.cause.platform, process.platform);
			assert.equal((result.cause.cause as { code?: string }).code, "ENOENT");
			assert.equal(result.fields.gitPath, join(dirs.root, "no-such-git"));
			// macOS installs git with the command line developer tools.
			assert.match(
				String(result.fields.installCommand),
				process.platform === "darwin" ? /^xcode-select --install$/u : /git/i,
			);
			assert.ok(result.hint.includes(String(result.fields.installCommand)));
			assert.equal(commands.length, 1, "one --version probe, nothing else");
			assert.deepEqual(readdirSync(dirs.home), [], "no store or worktree directories were created");
		} finally {
			restore();
		}
	});

	test("wraps a resolver's GitUnavailableError without losing it (#3109)", async () => {
		const unavailable = new GitUnavailableError({
			code: "not-installed",
			platform: process.platform,
			arch: process.arch,
			installDir: "/opt/git",
			systemGit: { path: "provisioned-git", problem: "probe-failed" },
		});
		const restore = setWorkspaceGitExecutableResolver(async () => {
			throw unavailable;
		});
		try {
			const error = await rejection(runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" }));
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "git-unavailable");
			assert.equal(error.cause, unavailable);
			assert.equal(error.fields.gitPath, "provisioned-git");
		} finally {
			restore();
		}
	});

	test("passes the injected executable environment to every command (#3109)", async () => {
		const restore = setWorkspaceGitExecutableResolver(async () => ({
			path: "git",
			env: { GIT_CONFIG_NOSYSTEM: "1", ATOMIC_WORKSPACE_TEST_MARKER: "injected" },
		}));
		try {
			const result = await runWorkspaceGit({
				cwd: dirs.root,
				args: ["-c", "alias.marker=!echo $ATOMIC_WORKSPACE_TEST_MARKER", "marker"],
				phase: "probe",
			});
			assert.equal(result.stdout.trim(), "injected");
		} finally {
			restore();
		}
	});

	test("rejects a failing command with git-failed, credentials redacted (#3109)", async () => {
		const error = await rejection(
			runWorkspaceGit({
				cwd: dirs.root,
				args: ["ls-remote", "https://user:secret-token@127.0.0.1:9/none.git"],
				phase: "fetch",
				timeoutMs: 20_000,
			}),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "git-failed");
		assert.equal(error.fields.phase, "fetch");
		assert.equal(error.retryable, true, "network phases may be retried");
		assert.equal(JSON.stringify(error.fields).includes("secret-token"), false);
		assert.equal(error.message.includes("secret-token"), false);
		const local = await rejection(
			runWorkspaceGit({ cwd: dirs.root, args: ["rev-parse", "HEAD"], phase: "validate" }),
		);
		assert.ok(isWorkspaceBindingError(local));
		assert.equal(local.retryable, false);
		assert.equal(typeof local.fields.status, "number");
	});

	test("redacts an '@'-bearing password from git's command and stderr (#4833)", async () => {
		const url = "https://alice:s3cr@tPass@example.invalid/org/repo.git";
		const error = await rejection(
			runWorkspaceGit({
				cwd: dirs.root,
				args: ["-c", `alias.leak=!f() { echo "fatal: unable to access '${url}/'" >&2; exit 128; }; f`, "leak", url],
				phase: "fetch",
			}),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "git-failed");
		assert.equal(error.fields.detail, "fatal: unable to access 'https://example.invalid/org/repo.git/'");
		assert.ok(String(error.fields.command).endsWith(" leak https://example.invalid/org/repo.git"));
		for (const fragment of ["s3cr", "tPass", "alice"]) {
			assert.equal(JSON.stringify(error.fields).includes(fragment), false, fragment);
			assert.equal(error.message.includes(fragment), false, fragment);
		}
	});

	test("times out a slow command with WorkspaceTimeoutError carrying phase and timings (#3109)", async () => {
		const error = await rejection(
			runWorkspaceGit({
				cwd: tmpdir(),
				args: ["-c", "alias.slow=!sleep 5", "slow"],
				phase: "clone",
				timeoutMs: 100,
			}),
		);
		assert.ok(isWorkspaceTimeoutError(error));
		assert.equal(error.code, "timeout");
		assert.equal(error.phase, "clone");
		assert.equal(error.timeoutMs, 100);
		assert.ok(error.elapsedMs >= 100);
		assert.equal(error.retryable, true);
	});

	test("propagates cancellation as signal.reason, never as a workspace error (#3109)", async () => {
		const controller = new AbortController();
		const reason = new Error("stop requested");
		const pending = runWorkspaceGit({
			cwd: tmpdir(),
			args: ["-c", "alias.slow=!sleep 5", "slow"],
			phase: "clone",
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(reason), 50);
		assert.equal(await rejection(pending), reason);
		const already = await rejection(
			runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe", signal: controller.signal }),
		);
		assert.equal(already, reason);
		const resolving = await rejection(
			resolveWorkspace(workspace({ repo: createRepository(dirs.root, "cancelled") }), { signal: controller.signal }),
		);
		assert.equal(resolving, reason);
	});

	test("restores the previous executable and stops observing when asked (#3109)", async () => {
		const restore = setWorkspaceGitExecutableResolver(async () => ({ path: join(dirs.root, "absent-git"), env: {} }));
		restore();
		const seen: string[][] = [];
		const stop = observeWorkspaceGitCommands((command) => seen.push([...command.args]));
		await runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" });
		stop();
		await runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" });
		assert.deepEqual(seen, [["--version"]]);
	});

	test("passes a resolver failure that is not about git through unchanged (#3109)", async () => {
		const failure = new Error("resolver bug");
		const restore = setWorkspaceGitExecutableResolver(async () => {
			throw failure;
		});
		try {
			assert.equal(
				await rejection(runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" })),
				failure,
			);
		} finally {
			restore();
		}
	});

	test("never lets git prompt (#3109)", async () => {
		const result = await runWorkspaceGit({
			cwd: dirs.root,
			args: ["-c", "alias.env=!echo $GIT_TERMINAL_PROMPT $GCM_INTERACTIVE", "env"],
			phase: "probe",
		});
		assert.equal(result.stdout.trim(), "0 never");
	});

	// POSIX: the alias kills git's own process from its shell.
	test.skipIf(process.platform === "win32")(
		"describes failures from git's own output and command (#3109)",
		async () => {
			const outside = await rejection(
				runWorkspaceGit({ cwd: dirs.root, args: ["rev-parse", "HEAD"], phase: "validate" }),
			);
			assert.ok(isWorkspaceBindingError(outside));
			assert.equal(outside.fields.command, "git rev-parse HEAD");
			assert.equal(outside.fields.cwd, dirs.root);
			assert.equal(outside.fields.status, 128);
			assert.match(String(outside.fields.detail), /not a git repository/);
			const stdoutOnly = await rejection(
				runWorkspaceGit({
					cwd: dirs.root,
					args: ["-c", "alias.fail=!echo only-stdout; exit 3", "fail"],
					phase: "probe",
				}),
			);
			assert.ok(isWorkspaceBindingError(stdoutOnly));
			assert.equal(stdoutOnly.fields.detail, "only-stdout");
			assert.equal(stdoutOnly.fields.status, 3);
			const stderrFirst = await rejection(
				runWorkspaceGit({
					cwd: dirs.root,
					args: ["-c", "alias.fail=!echo ignored-stdout; echo '  from-stderr  ' >&2; exit 4", "fail"],
					phase: "probe",
				}),
			);
			assert.ok(isWorkspaceBindingError(stderrFirst));
			assert.equal(stderrFirst.fields.detail, "from-stderr");
			const long = await rejection(
				runWorkspaceGit({
					cwd: dirs.root,
					args: ["-c", "alias.fail=!printf '%0900d' 0 >&2; exit 5", "fail"],
					phase: "probe",
				}),
			);
			assert.ok(isWorkspaceBindingError(long));
			assert.equal(long.fields.detail, "0".repeat(400), "git's output is cut to 400 characters");
			const killed = await rejection(
				runWorkspaceGit({ cwd: dirs.root, args: ["-c", "alias.die=!kill -KILL $PPID", "die"], phase: "probe" }),
			);
			assert.ok(isWorkspaceBindingError(killed));
			assert.equal(killed.fields.status, -1);
		},
	);

	test("tells a missing working directory apart from a missing git (#3109)", async () => {
		const missingCwd = await rejection(
			runWorkspaceGit({ cwd: join(dirs.root, "gone"), args: ["--version"], phase: "probe" }),
		);
		assert.ok(isWorkspaceBindingError(missingCwd));
		assert.equal(missingCwd.code, "git-failed");
		assert.equal(missingCwd.fields.status, null);
		const longPath = join(dirs.root, "g".repeat(200), "i".repeat(200), "git");
		const undo = setWorkspaceGitExecutableResolver(async () => ({ path: longPath, env: {} }));
		try {
			const long = await rejection(
				runWorkspaceGit({ cwd: join(dirs.root, "gone"), args: ["--version"], phase: "probe" }),
			);
			assert.ok(isWorkspaceBindingError(long));
			assert.equal(long.code, "git-failed");
			assert.equal(long.fields.detail, `spawn ${longPath} ENOENT`.slice(-400), "git's last words are kept");
		} finally {
			undo();
		}
	});

	// POSIX: spawning a directory fails with EACCES there; Windows reports ENOENT, which reads as a missing git.
	test.skipIf(process.platform === "win32")(
		"tells an executable that cannot run apart from a missing git (#3109)",
		async () => {
			const restore = setWorkspaceGitExecutableResolver(async () => ({ path: dirs.root, env: {} }));
			try {
				const directory = await rejection(runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe" }));
				assert.ok(isWorkspaceBindingError(directory));
				assert.equal(directory.code, "git-failed");
				assert.match(String(directory.fields.detail), /EACCES/);
			} finally {
				restore();
			}
		},
	);

	test("reports elapsed time of a timeout within its bound and leaves no abort listener behind (#3109)", async () => {
		const error = await rejection(
			runWorkspaceGit({
				cwd: tmpdir(),
				args: ["-c", "alias.slow=!sleep 5", "slow"],
				phase: "fetch",
				timeoutMs: 50,
			}),
		);
		assert.ok(isWorkspaceTimeoutError(error));
		assert.ok(error.elapsedMs < 5_000);
		assert.equal(error.fields.command, "git -c alias.slow=!sleep 5 slow");
		const controller = new AbortController();
		await runWorkspaceGit({ cwd: dirs.root, args: ["--version"], phase: "probe", signal: controller.signal });
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	// POSIX: the executable appears later as a symbolic link to git.
	test.skipIf(process.platform === "win32")(
		"checks git once per executable and does not remember a failed check (#3109)",
		async () => {
			// The git binary itself: macOS's /usr/bin/git is a launcher that refuses to run under another name.
			const gitPath = realpathSync(join(execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim(), "git"));
			const link = join(dirs.root, "late-git");
			const restore = setWorkspaceGitExecutableResolver(async () => ({ path: link, env: {} }));
			try {
				const missing = await rejection(assertWorkspaceGitAvailable());
				assert.ok(isWorkspaceBindingError(missing));
				assert.equal(missing.code, "git-unavailable");
				symlinkSync(gitPath, link);
				const { transcript } = await gitTranscript(async () => {
					await assertWorkspaceGitAvailable();
					await assertWorkspaceGitAvailable();
				});
				assert.deepEqual(transcript, ["probe: --version"]);
			} finally {
				restore();
			}
		},
	);

	// POSIX: the stand-in gits are shell scripts.
	test.skipIf(process.platform === "win32")(
		"fails fast on a git too old to lock a worktree while adding it, before any other work (#3109)",
		async () => {
			const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
			const gitReporting = (name: string, version: string): string => {
				const path = join(dirs.root, name);
				writeFileSync(
					path,
					`#!/bin/sh\ncase "$*" in *--version) echo "${version}"; exit 0 ;; esac\nexec '${realGit}' "$@"\n`,
				);
				chmodSync(path, 0o755);
				return path;
			};
			const old = gitReporting("old-git", "git version 2.32.7");
			const ancient = gitReporting("ancient-git", "git version 1.40.0");
			const restoreAncient = setWorkspaceGitExecutableResolver(async () => ({ path: ancient, env: {} }));
			try {
				const error = await rejection(assertWorkspaceGitAvailable());
				assert.ok(isWorkspaceBindingError(error));
				assert.equal(error.fields.version, "1.40.0");
			} finally {
				restoreAncient();
			}
			const restore = setWorkspaceGitExecutableResolver(async () => ({ path: old, env: {} }));
			try {
				const remote = createRemote(dirs.root, "needs-new-git");
				const { result: error, commands } = await countGitCommands(() =>
					rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
				);
				assert.ok(isWorkspaceBindingError(error));
				assert.equal(error.code, "git-unavailable");
				assert.equal(error.reason, "outdated");
				assert.deepEqual(
					{ ...error.fields, installCommand: typeof error.fields.installCommand },
					{ gitPath: old, version: "2.32.7", minimumVersion: "2.33", installCommand: "string" },
				);
				assert.equal(
					error.message,
					`Git is too old: ${old} is git 2.32.7, and workspaces need git 2.33 or later to lock worktrees while adding them (git-unavailable). Install a newer git (${error.fields.installCommand}) and make sure it is first on PATH.`,
				);
				assert.equal(commands.length, 1, "only the version probe ran");
				assert.equal(existsSync(join(dirs.home, "repos")), false, "nothing was created");
			} finally {
				restore();
			}
			for (const [name, version] of [
				["windows-git", "git version 2.33.0.windows.1"],
				["next-git", "git version 3.0.0"],
				["odd-git", "a git whose version line reads differently"],
			] as const) {
				const path = gitReporting(name, version);
				const accept = setWorkspaceGitExecutableResolver(async () => ({ path, env: {} }));
				try {
					await assertWorkspaceGitAvailable();
				} finally {
					accept();
				}
			}
		},
	);

	// POSIX: the stand-in git is a shell script.
	test.skipIf(process.platform === "win32")(
		"a caller cancelled during the shared git check stops waiting, while the check finishes for the others (#3109)",
		async () => {
			const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
			const slow = join(dirs.root, "slow-version-git");
			writeFileSync(
				slow,
				`#!/bin/sh\ncase "$*" in *--version) sleep 1; echo "git version 2.45.0"; exit 0 ;; esac\nexec '${realGit}' "$@"\n`,
			);
			chmodSync(slow, 0o755);
			const restore = setWorkspaceGitExecutableResolver(async () => ({ path: slow, env: {} }));
			try {
				const { result, transcript } = await gitTranscript(async () => {
					const controller = new AbortController();
					const reason = new Error("caller went away");
					const startedAt = Date.now();
					const cancelled = assertWorkspaceGitAvailable(controller.signal);
					const patient = assertWorkspaceGitAvailable();
					setTimeout(() => controller.abort(reason), 50);
					const outcome = await rejection(cancelled);
					const cancelledAfterMs = Date.now() - startedAt;
					await patient;
					return { outcome, reason, cancelledAfterMs };
				});
				assert.equal(result.outcome, result.reason);
				assert.ok(result.cancelledAfterMs < 1_000, "the cancelled caller did not wait for the check");
				assert.deepEqual(transcript, ["probe: --version"], "one check served both callers");
			} finally {
				restore();
			}
		},
	);

	// POSIX: the stand-in commands run under sh and report their pid.
	test.skipIf(process.platform === "win32")(
		"a timeout stops the commands git started too, before the call fails (#3109)",
		async () => {
			const pidFile = join(dirs.root, "child.pid");
			const error = await rejection(
				runWorkspaceGit({
					cwd: tmpdir(),
					args: ["-c", `alias.slow=!echo $$ > '${pidFile}'; exec sleep 30`, "slow"],
					phase: "fetch",
					timeoutMs: 300,
				}),
			);
			assert.ok(isWorkspaceTimeoutError(error));
			assert.equal(processAlive(Number(readFileSync(pidFile, "utf-8"))), false);

			// git stops the command it ran itself, but not one that command left running in the background.
			const backgroundFile = join(dirs.root, "background.pid");
			const startedAt = Date.now();
			const background = await rejection(
				runWorkspaceGit({
					cwd: tmpdir(),
					args: ["-c", `alias.spawner=!sleep 30 & echo $! > '${backgroundFile}'; wait`, "spawner"],
					phase: "fetch",
					timeoutMs: 300,
				}),
			);
			assert.ok(isWorkspaceTimeoutError(background));
			assert.ok(
				Date.now() - startedAt < WORKSPACE_PROCESS_STOP_GRACE_MS,
				"the whole group stopped at once, without waiting out the grace",
			);
			assert.equal(processAlive(Number(readFileSync(backgroundFile, "utf-8"))), false);
		},
	);

	// POSIX: the helper runs under sh and leaves the process group running after the main process exits.
	test.skipIf(process.platform === "win32")(
		"a helper that ignores SIGTERM and lets go of the output is killed before a stopped call fails (#3109)",
		async () => {
			const helperFile = join(dirs.root, "helper.pid");
			const error = await rejection(
				runWorkspaceProcess({
					path: "sh",
					args: [
						"-c",
						`(trap '' TERM; exec </dev/null >/dev/null 2>&1; exec sleep 30) & echo $! > '${helperFile}'; exec sleep 30`,
					],
					cwd: dirs.root,
					env: process.env,
					timeoutMs: 300,
					timeoutError: (elapsedMs) => new Error(`timed out after ${elapsedMs} ms`),
				}),
			);
			assert.match(String(error), /timed out after/);
			assert.equal(processAlive(Number(readFileSync(helperFile, "utf-8"))), false, "the helper was killed too");
		},
	);

	test.skipIf(process.platform === "win32")(
		"what the started process's pid is recorded with settles before the run ends, and its failure stops the process",
		async () => {
			const order: string[] = [];
			const outcome = await runWorkspaceProcess({
				path: "sh",
				args: ["-c", "exit 0"],
				cwd: dirs.root,
				env: process.env,
				onSpawn: async () => {
					await new Promise((resolveWait) => setTimeout(resolveWait, 200));
					order.push("recorded");
				},
			});
			order.push(outcome.kind);
			assert.deepEqual(order, ["recorded", "exited"]);

			const PID_FILE_WAIT_MS = 5_000;
			const PID_FILE_POLL_MS = 10;
			const pidFile = join(dirs.root, "unrecorded.pid");
			const error = await rejection(
				runWorkspaceProcess({
					path: "sh",
					args: ["-c", `echo $$ > '${pidFile}'; exec sleep 30`],
					cwd: dirs.root,
					env: process.env,
					onSpawn: async () => {
						const deadline = Date.now() + PID_FILE_WAIT_MS;
						while (!existsSync(pidFile) || readFileSync(pidFile, "utf-8").trim().length === 0) {
							assert.ok(Date.now() < deadline, "the child did not write its pid file in time");
							await new Promise((resolveWait) => setTimeout(resolveWait, PID_FILE_POLL_MS));
						}
						throw new Error("could not record the process");
					},
				}),
			);
			assert.match(String(error), /could not record the process/);
			assert.equal(processAlive(Number(readFileSync(pidFile, "utf-8"))), false);
		},
	);

	test.skipIf(process.platform === "win32")(
		"a git that will not stop is killed with everything it started once the grace is over (#3109)",
		async () => {
			const pidFile = join(dirs.root, "stubborn.pid");
			const controller = new AbortController();
			const pending = runWorkspaceGit({
				cwd: tmpdir(),
				args: ["-c", `alias.stubborn=!trap '' TERM; echo $$ > '${pidFile}'; while :; do sleep 1; done`, "stubborn"],
				phase: "fetch",
				timeoutMs: 300,
				signal: controller.signal,
			});
			setTimeout(() => controller.abort(new Error("cancelled while stopping")), 1_000);
			const error = await rejection(pending);
			assert.ok(isWorkspaceTimeoutError(error), "the timeout that started the stop is the failure");
			assert.equal(processAlive(Number(readFileSync(pidFile, "utf-8"))), false);
		},
	);

	test.skipIf(process.platform === "win32")(
		"cancelling a worktree addition mid-checkout lets git and its checkout stop and remove the worktree first (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "slow-checkout");
			git(repo, "config", "filter.slow.smudge", "sleep 0.05; cat");
			writeFileSync(join(repo, ".gitattributes"), "*.txt filter=slow\n");
			for (let index = 0; index < 60; index++) writeFileSync(join(repo, `file-${index}.txt`), `${index}\n`);
			git(repo, "add", ".");
			git(repo, "commit", "-q", "-m", "slow to check out");
			const path = join(dirs.root, "slow-worktree");
			const controller = new AbortController();
			const reason = new Error("stop adding");
			const pending = runWorkspaceGit({
				cwd: repo,
				args: ["worktree", "add", "--lock", "--reason", WORKTREE_ADDING_REASON, "-b", "feat/slow", path, "main"],
				phase: "worktree-add",
				signal: controller.signal,
			});
			const admin = join(repo, ".git", "worktrees");
			const checkingOut = (): boolean =>
				existsSync(path) && readdirSync(path).some((name) => name.startsWith("file-"));
			while (!checkingOut()) await new Promise((resolve) => setTimeout(resolve, 10));
			controller.abort(reason);
			assert.equal(await rejection(pending), reason);
			assert.equal(existsSync(path), false, "git removed the worktree it was adding");
			assert.deepEqual(existsSync(admin) ? readdirSync(admin) : [], [], "and its admin directory");
			assert.equal(git(repo, "branch", "--list", "feat/slow"), "feat/slow", "the new branch stays");
		},
	);
});

/** Whether `pid` is alive, waiting briefly for a process that was just killed to be gone. */
function processAlive(pid: number): boolean {
	const deadline = Date.now() + 2_000;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return false;
		}
		if (Date.now() > deadline) return true;
		execFileSync("sleep", ["0.05"]);
	}
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Record git commands with `paths` replaced by their names, longest first, so expectations hold on every platform. */
function transcriptOf(paths: Readonly<Record<string, string>>) {
	const named = Object.entries(paths)
		.sort(([, a], [, b]) => b.length - a.length)
		.map(([name, path]): [string, string] => [path, `<${name}>`]);
	return <T>(body: () => Promise<T>) =>
		gitTranscript(body, [...named, [UUID, "<uuid>"], [SHA, "<sha>"]]).then(({ result, transcript }) => ({
			result,
			transcript: transcript.filter((line) => line !== "probe: --version"),
		}));
}

/** A process that stays alive until stopped, standing in for a git that is still adding a worktree. */
function liveProcess(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	return new Promise((resolveSpawn, reject) => {
		child.once("spawn", () => resolveSpawn(child));
		child.once("error", reject);
	});
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	child.kill("SIGKILL");
	await exited;
}

function recordAdder(
	repo: string,
	path: string,
	adder: { readonly host: string; readonly pid: number; readonly startTime: string | null },
): void {
	const record = worktreeAdderRecord(realpathSync(join(repo, ".git")), path);
	mkdirSync(dirname(record), { recursive: true });
	writeFileSync(record, JSON.stringify(adder));
}

/** Atomic's own worktree path of `branch` in the local repository `repo`. */
function autoWorktree(repo: string, branch: string): string {
	const digest = createHash("sha256").update(realpathSync(repo)).digest("hex").slice(0, 12);
	return join(dirs.home, "worktrees", "local", `${basename(repo)}-${digest}`, ...branch.split("/"));
}

function countOf(commands: readonly (readonly string[])[], ...prefix: string[]): number {
	return commands.filter((args) => prefix.every((part, index) => args[index] === part)).length;
}

/** A worktree is complete: its recorded tree is its HEAD's, nothing differs, and no lock or index lock is left. */
function assertCompleteWorktree(worktree: string, tree?: string): void {
	if (tree !== undefined) assert.equal(tree, git(worktree, "rev-parse", "HEAD^{tree}"));
	assert.equal(git(worktree, "status", "--porcelain"), "");
	const adminDir = git(worktree, "rev-parse", "--absolute-git-dir");
	assert.equal(existsSync(join(adminDir, "locked")), false, "no lock is left");
	assert.equal(existsSync(join(adminDir, "index.lock")), false, "no index lock is left");
}

describe("interrupted worktree additions (#3109)", () => {
	test("locks a worktree while adding it and unlocks it once it is checked out (#3109)", async () => {
		const repo = createRepository(dirs.root, "marked");
		const { result, commands } = await countGitCommands(() =>
			resolveWorkspace(workspace({ repo, branch: "feat/marked" })),
		);
		const add = commands.find((args) => args[0] === "worktree" && args[1] === "add");
		assert.deepEqual(add?.slice(2, 5), ["--lock", "--reason", WORKTREE_ADDING_REASON]);
		assert.equal(countOf(commands, "worktree", "unlock", result.worktree), 1);
		assertCompleteWorktree(result.worktree, result.tree);
	});

	for (const [marker, checkedOut] of [
		[WORKTREE_ADDING_REASON, false],
		["initializing", true],
	] as const)
		test(`removes and adds again an addition interrupted under the "${marker}" lock${checkedOut ? " after its checkout" : ""} (#3109)`, async () => {
			const repo = createRepository(dirs.root, "interrupted");
			commitFile(repo, "app.txt", "app\n");
			const path = autoWorktree(repo, "feat/cut");
			interruptedWorktree(repo, path, "feat/cut", marker, { checkedOut });
			if (marker === WORKTREE_ADDING_REASON) await recordExitedAdder(repo, path);
			const { result, commands } = await countGitCommands(() =>
				resolveWorkspace(workspace({ repo, branch: "feat/cut" })),
			);
			assert.deepEqual(
				[
					countOf(commands, "worktree", "remove", "--force", "--force"),
					countOf(commands, "worktree", "prune"),
					countOf(commands, "worktree", "add"),
					countOf(commands, "worktree", "unlock"),
				],
				[1, 1, 1, 1],
			);
			assert.equal(result.worktree, realpathSync(path));
			assert.equal(readFileSync(join(path, "app.txt"), "utf-8").replaceAll("\r\n", "\n"), "app\n");
			assertCompleteWorktree(path, result.tree);
		});

	test("repairs an interrupted addition when a recorded binding is restored (#3109)", async () => {
		const repo = createRepository(dirs.root, "resumed");
		const binding = await resolveWorkspace(workspace({ repo, branch: "feat/resume" }));
		git(repo, "worktree", "remove", "--force", binding.worktree);
		interruptedWorktree(repo, binding.worktree, "feat/resume", WORKTREE_ADDING_REASON, { newBranch: false });
		await recordExitedAdder(repo, binding.worktree);
		const { result, commands } = await countGitCommands(() => restoreWorkspace(binding));
		assert.equal(result, binding.worktree);
		assert.equal(countOf(commands, "worktree", "remove", "--force", "--force"), 1);
		assertCompleteWorktree(binding.worktree);
	});

	test("an addition whose git still runs is left alone and fails retryable naming that git (#3109)", async () => {
		const repo = createRepository(dirs.root, "still-adding");
		const path = autoWorktree(repo, "feat/busy");
		const adminDir = resolvePath(interruptedWorktree(repo, path, "feat/busy", WORKTREE_ADDING_REASON));
		const adder = await liveProcess();
		onTestFinished(() => stopProcess(adder));
		onTestFinished(await keepProcessPid(adder));
		try {
			recordAdder(repo, path, { host: hostname(), pid: adder.pid!, startTime: null });
			const { result: error, commands } = await countGitCommands(() =>
				rejection(resolveWorkspace(workspace({ repo, branch: "feat/busy" }))),
			);
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "incomplete-worktree");
			assert.equal(error.reason, "addition-in-progress");
			assert.equal(error.retryable, true);
			assert.deepEqual(
				{
					...error.fields,
					adminDir: resolvePath(String(error.fields.adminDir)),
					worktree: resolvePath(String(error.fields.worktree)),
				},
				{
					repo,
					repository: realpathSync(repo),
					branch: "feat/busy",
					worktree: path,
					adminDir,
					marker: WORKTREE_ADDING_REASON,
					adderPid: adder.pid!,
					adderHost: hostname(),
					adderStartTime: null,
				},
			);
			assert.equal(
				error.message,
				`Workspace worktree is still being added: git (pid ${adder.pid} on ${hostname()}) is still adding ${error.fields.worktree} (incomplete-worktree). Wait for it to finish, or stop it with kill -TERM -${adder.pid} (Windows: taskkill /T /PID ${adder.pid}), then bind again.`,
			);
			assert.equal(countOf(commands, "worktree", "remove"), 0, "a running addition is never removed");
			assert.equal(existsSync(join(adminDir, "locked")), true);
			await stopProcess(adder);
			const { commands: repair } = await countGitCommands(() =>
				resolveWorkspace(workspace({ repo, branch: "feat/busy" })),
			);
			assert.equal(countOf(repair, "worktree", "remove", "--force", "--force"), 1, "repaired once its git is gone");
			assertCompleteWorktree(path);
		} finally {
			await stopProcess(adder);
		}
	});

	test("an index lock with no recorded adder counts as a checkout still running (#3109)", async () => {
		const repo = createRepository(dirs.root, "unnamed-adder");
		const path = autoWorktree(repo, "feat/unnamed");
		interruptedWorktree(repo, path, "feat/unnamed", "initializing");
		const restoreWait = setWorktreeAdditionWait({ probes: 1_000, intervalMs: 50 });
		const { result: error, commands } = await countGitCommands(() =>
			rejection(resolveWorkspace(workspace({ repo, branch: "feat/unnamed" }))),
		).finally(restoreWait);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.reason, "addition-in-progress");
		assert.equal(error.fields.adderPid, null);
		assert.equal(error.fields.adderHost, null);
		assert.equal(error.fields.adderStartTime, null);
		const { worktree, adminDir, repository } = error.fields;
		assert.equal(
			error.message,
			`Workspace worktree is still being added: ${worktree} may still be checking out: ${adminDir} holds an index lock, and no record names the git adding it (incomplete-worktree). Wait for that checkout to finish, then bind again. If no git is running, remove the worktree with git -C ${repository} worktree remove --force --force ${worktree}.`,
		);
		assert.equal(countOf(commands, "worktree", "remove"), 0);
	});

	for (const [kind, record] of [
		["empty", ""],
		["partial", '{"host":"'],
		["without a host", '{"host":7,"pid":2,"startTime":null}'],
		["with pid 0", '{"host":"h","pid":0,"startTime":null}'],
		["with a fractional pid", '{"host":"h","pid":2.5,"startTime":null}'],
		["with a numeric start time", '{"host":"h","pid":2,"startTime":3}'],
		["null", "null"],
	] as const)
		test(`a crash that left the adder record ${kind} does not stop its addition from being repaired (#3109)`, async () => {
			const repo = createRepository(dirs.root, `cut-record-${kind}`);
			const path = autoWorktree(repo, "feat/cut-record");
			interruptedWorktree(repo, path, "feat/cut-record", WORKTREE_ADDING_REASON);
			const file = worktreeAdderRecord(realpathSync(join(repo, ".git")), path);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, record);
			const { commands } = await countGitCommands(() =>
				resolveWorkspace(workspace({ repo, branch: "feat/cut-record" })),
			);
			assert.deepEqual(
				[
					countOf(commands, "worktree", "remove", "--force", "--force"),
					countOf(commands, "worktree", "prune"),
					countOf(commands, "worktree", "add"),
				],
				[1, 1, 1],
			);
			assertCompleteWorktree(path);
		});

	// POSIX: the stand-in git that dies after its checkout is a shell script.
	test.skipIf(process.platform === "win32")(
		"an addition whose git failed keeps its record, so the next bind repairs it at once (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "died-adding");
			const path = autoWorktree(repo, "feat/died");
			const failed = await withInjectedGit(dirs.root, { FAKE_GIT_MODE: "add-dies" }, () =>
				rejection(resolveWorkspace(workspace({ repo, branch: "feat/died" }))),
			);
			assert.ok(isWorkspaceBindingError(failed));
			assert.equal(failed.code, "git-failed");
			assert.equal(existsSync(worktreeAdderRecord(realpathSync(join(repo, ".git")), path)), true);
			const restoreWait = setWorktreeAdditionWait({ probes: 1_000, intervalMs: 50 });
			try {
				const { commands } = await countGitCommands(() =>
					resolveWorkspace(workspace({ repo, branch: "feat/died" })),
				);
				assert.equal(countOf(commands, "worktree", "remove", "--force", "--force"), 1);
				assertCompleteWorktree(path);
			} finally {
				restoreWait();
			}
		},
	);

	test("an adder recorded on another host cannot be checked, so it counts as running (#3109)", async () => {
		const repo = createRepository(dirs.root, "remote-adder");
		const path = autoWorktree(repo, "feat/remote");
		interruptedWorktree(repo, path, "feat/remote", WORKTREE_ADDING_REASON);
		const exited = spawnSync(process.execPath, ["-e", ""]).pid!;
		recordAdder(repo, path, { host: "another-host.invalid", pid: exited, startTime: null });
		const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/remote" })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.reason, "addition-in-progress");
		assert.equal(error.fields.adderHost, "another-host.invalid");
	});

	// Linux: only /proc gives a process's start time cheaply.
	test.skipIf(process.platform !== "linux")(
		"a recorded pid now used by a later process is not the adder, so the addition is repaired (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "reused-pid");
			const path = autoWorktree(repo, "feat/reused");
			interruptedWorktree(repo, path, "feat/reused", WORKTREE_ADDING_REASON);
			recordAdder(repo, path, { host: hostname(), pid: process.pid, startTime: "0" });
			const { commands } = await countGitCommands(() =>
				resolveWorkspace(workspace({ repo, branch: "feat/reused" })),
			);
			assert.equal(countOf(commands, "worktree", "remove", "--force", "--force"), 1);
			assertCompleteWorktree(path);
		},
	);

	test.skipIf(process.platform !== "linux")(
		"a recorded adder still running under its recorded start time counts as running (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "same-start");
			const path = autoWorktree(repo, "feat/same");
			interruptedWorktree(repo, path, "feat/same", WORKTREE_ADDING_REASON);
			const adder = await liveProcess();
			try {
				const startTime = readFileSync(`/proc/${adder.pid}/stat`, "utf-8").split(") ")[1]!.split(" ")[19]!;
				recordAdder(repo, path, { host: hostname(), pid: adder.pid!, startTime });
				const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/same" })));
				assert.ok(isWorkspaceBindingError(error));
				assert.equal(error.reason, "addition-in-progress");
				assert.equal(error.fields.adderStartTime, startTime);
			} finally {
				await stopProcess(adder);
			}
		},
	);

	test("an unreadable adder record is not trusted: the index lock decides (#3109)", async () => {
		const repo = createRepository(dirs.root, "record-dir");
		const path = autoWorktree(repo, "feat/dir");
		interruptedWorktree(repo, path, "feat/dir", WORKTREE_ADDING_REASON);
		mkdirSync(worktreeAdderRecord(realpathSync(join(repo, ".git")), path), { recursive: true });
		const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/dir" })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.reason, "addition-in-progress");
		assert.equal(error.fields.adderPid, null);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a worktree link that cannot be read fails with filesystem-failed (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "unreadable-link");
			const path = autoWorktree(repo, "feat/unreadable");
			interruptedWorktree(repo, path, "feat/unreadable", WORKTREE_ADDING_REASON, { checkedOut: true });
			chmodSync(join(path, ".git"), 0o000);
			try {
				const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/unreadable" })));
				assert.ok(isWorkspaceBindingError(error));
				assert.equal(error.code, "filesystem-failed");
				assert.deepEqual(error.fields, { operation: "read", path: join(path, ".git"), errno: "EACCES" });
			} finally {
				chmodSync(join(path, ".git"), 0o644);
			}
		},
	);

	test("a bind cancelled while another git still adds the worktree rejects with the signal's reason (#3109)", async () => {
		const repo = createRepository(dirs.root, "cancelled-wait");
		const path = autoWorktree(repo, "feat/wait");
		interruptedWorktree(repo, path, "feat/wait", WORKTREE_ADDING_REASON);
		const adder = await liveProcess();
		onTestFinished(() => stopProcess(adder));
		onTestFinished(await keepProcessPid(adder));
		const restoreWait = setWorktreeAdditionWait({ probes: 1_000, intervalMs: 10 });
		try {
			recordAdder(repo, path, { host: hostname(), pid: adder.pid!, startTime: null });
			const controller = new AbortController();
			const reason = new Error("caller went away");
			const pending = resolveWorkspace(workspace({ repo, branch: "feat/wait" }), { signal: controller.signal });
			setTimeout(() => controller.abort(reason), 100);
			assert.equal(await rejection(pending), reason);
			assert.equal(existsSync(join(path, ".git")), true, "the running addition was not touched");
			await stopProcess(adder);
			const binding = await resolveWorkspace(workspace({ repo, branch: "feat/wait" }));
			assertCompleteWorktree(binding.worktree);
		} finally {
			restoreWait();
			await stopProcess(adder);
		}
	});

	// POSIX: the stand-in git that holds the addition open is a shell script.
	test.skipIf(process.platform === "win32")(
		"records the git adding a worktree while it runs, and removes the record once the worktree is added (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "recorded");
			const path = autoWorktree(repo, "feat/recorded");
			const record = worktreeAdderRecord(realpathSync(join(repo, ".git")), path);
			await withInjectedGit(
				dirs.root,
				{
					FAKE_GIT_SLOW: "worktree add",
					FAKE_GIT_SLEEP: "2",
					FAKE_GIT_MARKER: join(dirs.root, "held-open"),
				},
				async () => {
					const binding = resolveWorkspace(workspace({ repo, branch: "feat/recorded" }));
					try {
						while (!existsSync(record)) await new Promise((resolve) => setTimeout(resolve, 10));
						const recorded = JSON.parse(readFileSync(record, "utf-8")) as {
							host: string;
							pid: number;
							startTime: string | null;
						};
						assert.equal(recorded.host, hostname());
						assert.equal(
							processAlive(recorded.pid),
							true,
							"the recorded pid is the git still adding the worktree",
						);
						if (process.platform === "linux") {
							const stat = readFileSync(`/proc/${recorded.pid}/stat`, "utf-8");
							assert.equal(
								recorded.startTime,
								stat.split(") ")[1]!.split(" ")[19],
								"its start time, from /proc",
							);
						} else assert.equal(recorded.startTime, null);
					} finally {
						await binding;
					}
				},
			);
			assert.equal(existsSync(record), false);
		},
	);

	test.skipIf(process.platform === "win32")(
		"a git whose adder cannot be recorded is stopped before it adds anything (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "unrecordable");
			writeFileSync(join(realpathSync(join(repo, ".git")), "atomic-worktree-adders"), "in the way\n");
			const path = autoWorktree(repo, "feat/unrecorded");
			const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/unrecorded" })));
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "filesystem-failed");
			assert.equal(error.fields.operation, "record the git adding");
			assert.equal(existsSync(path), false, "git removed what it had started adding");
		},
	);

	test.skipIf(process.platform === "win32")(
		"a bind whose adder cannot be recorded fails before git adds anything, however fast that git is (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "unrecordable-late");
			writeFileSync(join(realpathSync(join(repo, ".git")), "atomic-worktree-adders"), "in the way\n");
			const path = autoWorktree(repo, "feat/unrecorded-late");
			const error = await withInjectedGit(dirs.root, { FAKE_GIT_MODE: "add-outlives-stop" }, () =>
				rejection(resolveWorkspace(workspace({ repo, branch: "feat/unrecorded-late" }))),
			);
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "filesystem-failed");
			assert.equal(error.fields.operation, "record the git adding");
			assert.equal(existsSync(path), false, "git added nothing");
			assert.doesNotMatch(git(repo, "worktree", "list", "--porcelain"), /unrecorded-late/);
		},
	);

	test.skipIf(process.platform === "win32")(
		"a git whose adder's record cannot be written once it started is stopped, and a later bind repairs what it left (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "unwritable-record");
			const path = autoWorktree(repo, "feat/unwritable-record");
			// The record's directory can be made, so git starts; the record itself cannot replace a directory.
			const record = worktreeAdderRecord(realpathSync(join(repo, ".git")), path);
			mkdirSync(record, { recursive: true });
			writeFileSync(join(record, "in-the-way"), "");
			const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/unwritable-record" })));
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "filesystem-failed");
			assert.equal(error.fields.operation, "record the git adding");

			rmSync(record, { recursive: true });
			const binding = await resolveWorkspace(workspace({ repo, branch: "feat/unwritable-record" }));
			assert.equal(binding.worktree, realpathSync(path));
			assert.equal(git(binding.worktree, "branch", "--show-current"), "feat/unwritable-record");
		},
	);

	test("binds a worktree the user locked for another reason and leaves it locked (#3109)", async () => {
		const repo = createRepository(dirs.root, "user-locked");
		const path = join(dirs.root, "removable", "feat-user");
		git(repo, "worktree", "add", "-q", "--lock", "--reason", "on a removable drive", "-b", "feat/user", path, "main");
		const { result, commands } = await countGitCommands(() =>
			resolveWorkspace(workspace({ repo, branch: "feat/user", worktree: path })),
		);
		assert.equal(result.worktree, realpathSync(path));
		assert.equal(countOf(commands, "worktree", "remove"), 0);
		assert.equal(countOf(commands, "worktree", "add"), 0);
		const adminDir = git(path, "rev-parse", "--absolute-git-dir");
		assert.equal(readFileSync(join(adminDir, "locked"), "utf-8").trim(), "on a removable drive");
	});

	test("adds again over an orphaned directory at Atomic's path, and refuses one at a caller's path (#3109)", async () => {
		const repo = createRepository(dirs.root, "orphans");
		const commonDir = realpathSync(join(repo, ".git"));
		const ghost = join(commonDir, "worktrees", "ghost");
		const orphan = (path: string): void => {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, ".git"), `gitdir: ${ghost}\n`);
			writeFileSync(join(path, "leftover.txt"), "half a checkout\n");
		};
		const atomicPath = autoWorktree(repo, "feat/orphan");
		orphan(atomicPath);
		const repaired = await resolveWorkspace(workspace({ repo, branch: "feat/orphan" }));
		assert.equal(repaired.worktree, realpathSync(atomicPath));
		assert.equal(existsSync(join(atomicPath, "leftover.txt")), false);
		assertCompleteWorktree(atomicPath, repaired.tree);

		const callers = join(dirs.root, "mine");
		orphan(callers);
		const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/mine", worktree: callers })));
		assert.ok(error instanceof WorkspaceBindingError);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "incomplete-worktree");
		assert.equal(error.reason, "orphaned-directory");
		assert.equal(error.retryable, false);
		assert.deepEqual(error.fields, {
			repo,
			repository: realpathSync(repo),
			branch: "feat/mine",
			worktree: callers,
			adminDir: ghost,
			marker: "",
		});
		assert.match(error.hint, new RegExp(`worktree remove --force --force ${callers.replaceAll("\\", "\\\\")}`));
		assert.equal(existsSync(join(callers, "leftover.txt")), true, "a caller's directory is never deleted");

		for (const [name, notInside] of [
			["kept", join(dirs.home, "kept")],
			["home", dirs.home],
			["root", join(dirs.home, "worktrees")],
		] as const) {
			orphan(notInside);
			const outside = await rejection(
				resolveWorkspace(workspace({ repo, branch: `feat/${name}`, worktree: notInside })),
			);
			assert.ok(isWorkspaceBindingError(outside), `${name}: ${String(outside)}`);
			assert.equal(
				outside.reason,
				"orphaned-directory",
				"only paths inside Atomic's worktree directory are Atomic's",
			);
			assert.equal(existsSync(join(notInside, "leftover.txt")), true);
		}
	});

	test("never treats another repository's worktree as an interrupted addition (#3109)", async () => {
		const repo = createRepository(dirs.root, "ours");
		const other = createRepository(dirs.root, "theirs");
		const path = join(dirs.root, "theirs-worktree");
		interruptedWorktree(other, path, "feat/theirs", WORKTREE_ADDING_REASON);
		const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/theirs", worktree: path })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "wrong-repository");
		assert.equal(git(other, "worktree", "list", "--porcelain").includes("feat/theirs"), true, "theirs is untouched");
	});

	test("a directory whose .git file names no admin directory is reported, not repaired (#3109)", async () => {
		const repo = createRepository(dirs.root, "garbled");
		const path = autoWorktree(repo, "feat/garbled");
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, ".git"), "not a link\n");
		const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/garbled" })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "wrong-repository");
		assert.equal(error.reason, "not-a-worktree");
	});

	test("binding a repository's own checkout takes no repository lock (#3109)", async () => {
		const repo = createRepository(dirs.root, "in-place");
		await resolveWorkspace(workspace({ repo }));
		assert.equal(existsSync(join(repo, ".git", "atomic-repository-lock.sqlite")), false);
	});

	test("a worktree another process finished while this one waited for the lock is used with its changes (#3109)", async () => {
		const repo = createRepository(dirs.root, "finished-meanwhile");
		const path = autoWorktree(repo, "feat/late");
		interruptedWorktree(repo, path, "feat/late", WORKTREE_ADDING_REASON, { checkedOut: true });
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let locked!: () => void;
		const holding = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const holder = withRepositoryLock(realpathSync(join(repo, ".git")), async () => {
			locked();
			await released;
			git(repo, "worktree", "unlock", path);
			writeFileSync(join(path, "notes.txt"), "work in progress\n");
		});
		await holding;
		const listed = new Promise<void>((resolve) => {
			const stop = observeWorkspaceGitCommands((command) => {
				if (command.args[0] === "worktree" && command.args[1] === "list") {
					stop();
					resolve();
				}
			});
		});
		const binding = resolveWorkspace(workspace({ repo, branch: "feat/late" }));
		await listed;
		await new Promise((resolve) => setTimeout(resolve, 200));
		release();
		await holder;
		assert.equal((await binding).worktree, realpathSync(path));
		assert.equal(readFileSync(join(path, "notes.txt"), "utf-8"), "work in progress\n", "nothing was re-added");
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"an orphaned directory that cannot be removed fails with filesystem-failed naming the removal (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "unremovable");
			const path = autoWorktree(repo, "feat/stuck");
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, ".git"), `gitdir: ${join(realpathSync(join(repo, ".git")), "worktrees", "gone")}\n`);
			chmodSync(dirname(path), 0o555);
			try {
				const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/stuck" })));
				assert.ok(isWorkspaceBindingError(error));
				assert.equal(error.code, "filesystem-failed");
				assert.equal(error.fields.operation, "remove orphaned worktree");
				assert.equal(error.fields.path, path);
			} finally {
				chmodSync(dirname(path), 0o755);
			}
		},
	);

	test("refuses git's own interrupted addition at a caller's path and names the fix (#3109)", async () => {
		const repo = createRepository(dirs.root, "callers-cut");
		const path = join(dirs.root, "callers-cut-worktree");
		const adminDir = resolvePath(interruptedWorktree(repo, path, "feat/cut", "initializing"));
		const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/cut", worktree: path })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "incomplete-worktree");
		assert.equal(error.reason, "interrupted-add");
		assert.equal(error.fields.adminDir, adminDir);
		assert.equal(error.fields.marker, "initializing");
		const root = realpathSync(repo);
		assert.equal(
			error.message,
			`Workspace worktree is incomplete: ${path} was left by an interrupted checkout (${adminDir} is locked: initializing) (incomplete-worktree). Remove it with git -C ${root} worktree remove --force --force ${path} and git -C ${root} worktree prune, or delete the directory if git no longer lists it, then bind again.`,
		);
		assert.equal(existsSync(join(adminDir, "locked")), true, "left for the user to inspect");
	});

	test("an interrupted addition of another branch at the requested path is refused, not removed (#3109)", async () => {
		const repo = createRepository(dirs.root, "other-branch-cut");
		const path = join(dirs.root, "shared-path");
		const adminDir = interruptedWorktree(repo, path, "feat/a", WORKTREE_ADDING_REASON, { checkedOut: true });
		await recordExitedAdder(repo, path);
		writeFileSync(join(path, "notes.txt"), "work on a\n");
		const { result: error, commands } = await countGitCommands(() =>
			rejection(resolveWorkspace(workspace({ repo, branch: "feat/b", worktree: path }))),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "wrong-branch");
		assert.equal(error.reason, "different-branch");
		assert.deepEqual(error.fields, { repo, worktree: path, expected: "feat/b", actual: "feat/a" });
		assert.equal(countOf(commands, "worktree", "remove"), 0, "nothing was removed");
		assert.equal(readFileSync(join(path, "notes.txt"), "utf-8"), "work on a\n");
		assert.equal(existsSync(join(adminDir, "locked")), true);
	});

	test("an addition Atomic interrupted at a caller's path is never handed out, so it is added again (#3109)", async () => {
		const repo = createRepository(dirs.root, "callers-ours");
		const path = join(dirs.root, "callers-ours-worktree");
		interruptedWorktree(repo, path, "feat/ours", WORKTREE_ADDING_REASON);
		await recordExitedAdder(repo, path);
		const binding = await resolveWorkspace(workspace({ repo, branch: "feat/ours", worktree: path }));
		assertCompleteWorktree(path, binding.tree);
	});

	test.skipIf(process.platform === "win32")(
		"reports a removal git refuses as repair-failed, with git's error as the cause (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "stuck");
			const path = autoWorktree(repo, "feat/stuck");
			interruptedWorktree(repo, path, "feat/stuck", WORKTREE_ADDING_REASON);
			await recordExitedAdder(repo, path);
			const error = await withInjectedGit(dirs.root, { FAKE_GIT_MODE: "remove-fails" }, () =>
				rejection(resolveWorkspace(workspace({ repo, branch: "feat/stuck" }))),
			);
			assert.ok(isWorkspaceBindingError(error));
			assert.equal(error.code, "incomplete-worktree");
			assert.equal(error.reason, "repair-failed");
			assert.equal(error.fields.worktree, path);
			assert.ok(isWorkspaceBindingError(error.cause));
			assert.equal(error.cause.code, "git-failed");
			assert.equal(error.cause.fields.phase, "worktree-add");
			assert.match(String(error.cause.fields.detail), /injected remove failure/);
			assert.equal(existsSync(path), true);
		},
	);
});

/** Write the admin `HEAD` git has written so far: none yet, or the placeholder git 2.43 and older write first. */
function writeAdminHead(adminDir: string, head: string | undefined): void {
	if (head === undefined) rmSync(join(adminDir, "HEAD"));
	else writeFileSync(join(adminDir, "HEAD"), head);
}

const PLACEHOLDER_HEAD = `${"0".repeat(40)}\n`;

/**
 * Turn the lock of the worktree at `adminDir` into a FIFO, so a bind that reads it blocks there. `reading` settles once
 * the bind has opened it; what the test changes before `release` happens between that read and the bind's next one.
 */
function pauseLockRead(adminDir: string): { readonly reading: Promise<void>; readonly release: () => Promise<void> } {
	const lock = join(adminDir, "locked");
	rmSync(lock, { force: true });
	execFileSync("mkfifo", [lock]);
	const writer = open(lock, "w");
	return { reading: writer.then(() => undefined), release: async () => (await writer).close() };
}

describe("bindings racing an addition or its repair (#4429)", () => {
	for (const [kind, head] of [
		["no HEAD", undefined],
		["git's placeholder HEAD", PLACEHOLDER_HEAD],
	] as const)
		test(`an addition whose git has not recorded its branch yet (${kind}) is waited for, not refused as another branch (#4429)`, async () => {
			const repo = createRepository(dirs.root, "unrecorded-branch");
			const path = autoWorktree(repo, "feat/unrecorded");
			const adminDir = resolvePath(interruptedWorktree(repo, path, "feat/unrecorded", WORKTREE_ADDING_REASON));
			writeAdminHead(adminDir, head);
			const adder = await liveProcess();
			try {
				recordAdder(repo, path, { host: hostname(), pid: adder.pid!, startTime: null });
				const { result: error, commands } = await countGitCommands(() =>
					rejection(resolveWorkspace(workspace({ repo, branch: "feat/unrecorded" }))),
				);
				assert.ok(isWorkspaceBindingError(error));
				assert.equal(error.code, "incomplete-worktree");
				assert.equal(error.reason, "addition-in-progress");
				assert.equal(error.fields.adderPid, adder.pid);
				assert.equal(resolvePath(String(error.fields.adminDir)), adminDir);
				assert.equal(countOf(commands, "worktree", "remove"), 0, "a running addition is never removed");
				assert.equal(existsSync(join(adminDir, "locked")), true);
			} finally {
				await stopProcess(adder);
			}
		});

	for (const [kind, head, gitRemovals] of [
		["no HEAD", undefined, 0],
		["git's placeholder HEAD", PLACEHOLDER_HEAD, 1],
	] as const)
		test(`an addition killed before git recorded its branch (${kind}) is removed and added again (#4429)`, async () => {
			const repo = createRepository(dirs.root, "killed-before-branch");
			commitFile(repo, "app.txt", "app\n");
			const path = autoWorktree(repo, "feat/early");
			const adminDir = interruptedWorktree(repo, path, "feat/early", WORKTREE_ADDING_REASON);
			writeAdminHead(adminDir, head);
			await recordExitedAdder(repo, path);
			const { result, commands } = await countGitCommands(() =>
				resolveWorkspace(workspace({ repo, branch: "feat/early" })),
			);
			assert.deepEqual(
				[
					countOf(commands, "worktree", "remove", "--force", "--force"),
					countOf(commands, "worktree", "prune"),
					countOf(commands, "worktree", "add"),
					countOf(commands, "worktree", "unlock"),
				],
				[gitRemovals, 1, 1, 1],
			);
			assert.equal(result.worktree, realpathSync(path));
			assert.equal(readFileSync(join(path, "app.txt"), "utf-8").replaceAll("\r\n", "\n"), "app\n");
			assertCompleteWorktree(path, result.tree);
			assert.deepEqual(
				readdirSync(join(realpathSync(join(repo, ".git")), "worktrees")),
				[basename(adminDir)],
				"the interrupted addition's admin directory is gone, not left beside the new one",
			);
		});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"an interrupted addition without HEAD that cannot be removed fails with filesystem-failed naming the removal (#4429)",
		async () => {
			const repo = createRepository(dirs.root, "stuck-early");
			const path = autoWorktree(repo, "feat/stuck-early");
			writeAdminHead(interruptedWorktree(repo, path, "feat/stuck-early", WORKTREE_ADDING_REASON), undefined);
			await recordExitedAdder(repo, path);
			chmodSync(dirname(path), 0o555);
			try {
				const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/stuck-early" })));
				assert.ok(isWorkspaceBindingError(error));
				assert.equal(error.code, "filesystem-failed");
				assert.equal(error.fields.operation, "remove interrupted worktree");
				assert.equal(error.fields.path, path);
			} finally {
				chmodSync(dirname(path), 0o755);
			}
		},
	);

	for (const [kind, leave] of [
		["a path it has not created yet", (_repo: string, _path: string) => ""],
		[
			"an empty directory",
			(_repo: string, path: string) => {
				mkdirSync(path, { recursive: true });
				return "";
			},
		],
		[
			"a complete worktree whose lock it already removed",
			(repo: string, path: string) => {
				git(repo, "worktree", "add", "-q", "-b", "feat/busy-path", path);
				return "";
			},
		],
		[
			"a worktree whose admin directory it already removed",
			(repo: string, path: string) => {
				const adminDir = join(realpathSync(join(repo, ".git")), "worktrees", "removed");
				mkdirSync(path, { recursive: true });
				writeFileSync(join(path, ".git"), `gitdir: ${adminDir}\n`);
				return adminDir;
			},
		],
	] as const)
		test(`a recorded git still adding or removing the worktree, at ${kind}, is waited for: nothing is used, removed or added (#4429)`, async () => {
			const repo = createRepository(dirs.root, "busy-path");
			const path = autoWorktree(repo, "feat/busy-path");
			const adminDir = leave(repo, path);
			const before = existsSync(path) ? readdirSync(path).sort() : undefined;
			const adder = await liveProcess();
			try {
				recordAdder(repo, path, { host: hostname(), pid: adder.pid!, startTime: null });
				const { result: error, commands } = await countGitCommands(() =>
					rejection(resolveWorkspace(workspace({ repo, branch: "feat/busy-path" }))),
				);
				assert.ok(isWorkspaceBindingError(error), String(error));
				assert.equal(error.reason, "addition-in-progress");
				assert.equal(error.retryable, true);
				assert.deepEqual(
					{ ...error.fields, worktree: resolvePath(String(error.fields.worktree)) },
					{
						repo,
						repository: realpathSync(repo),
						branch: "feat/busy-path",
						worktree: path,
						adminDir,
						marker: "",
						adderPid: adder.pid!,
						adderHost: hostname(),
						adderStartTime: null,
					},
				);
				assert.deepEqual([countOf(commands, "worktree", "add"), countOf(commands, "worktree", "remove")], [0, 0]);
				assert.deepEqual(existsSync(path) ? readdirSync(path).sort() : undefined, before, "the path is untouched");
			} finally {
				await stopProcess(adder);
			}
		});

	test("a worktree is used once the recorded git that was still running at it has exited (#4429)", async () => {
		const repo = createRepository(dirs.root, "exited-adder");
		const path = autoWorktree(repo, "feat/exited");
		git(repo, "worktree", "add", "-q", "-b", "feat/exited", path);
		writeFileSync(join(path, "notes.txt"), "kept\n");
		const adder = await liveProcess();
		onTestFinished(() => stopProcess(adder));
		onTestFinished(await keepProcessPid(adder));
		try {
			recordAdder(repo, path, { host: hostname(), pid: adder.pid!, startTime: null });
			const busy = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/exited" })));
			assert.ok(isWorkspaceBindingError(busy));
			assert.equal(busy.reason, "addition-in-progress");
		} finally {
			await stopProcess(adder);
		}
		const { result, commands } = await countGitCommands(() =>
			resolveWorkspace(workspace({ repo, branch: "feat/exited" })),
		);
		assert.equal(result.worktree, realpathSync(path));
		assert.equal(countOf(commands, "worktree", "add"), 0);
		assert.equal(readFileSync(join(path, "notes.txt"), "utf-8"), "kept\n");
	});

	test("an empty directory at Atomic's path, left by an addition stopped before its link, is added over (#4429)", async () => {
		const repo = createRepository(dirs.root, "linkless");
		const path = autoWorktree(repo, "feat/linkless");
		mkdirSync(path, { recursive: true });
		await recordExitedAdder(repo, path);
		const { result, commands } = await countGitCommands(() =>
			resolveWorkspace(workspace({ repo, branch: "feat/linkless" })),
		);
		assert.equal(countOf(commands, "worktree", "add"), 1);
		assert.equal(result.worktree, realpathSync(path));
		assertCompleteWorktree(path, result.tree);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"an empty-looking directory at Atomic's path that cannot be listed fails with filesystem-failed (#4429)",
		async () => {
			const repo = createRepository(dirs.root, "unlistable");
			const path = autoWorktree(repo, "feat/unlistable");
			mkdirSync(path, { recursive: true });
			chmodSync(path, 0o311);
			try {
				const error = await rejection(resolveWorkspace(workspace({ repo, branch: "feat/unlistable" })));
				assert.ok(isWorkspaceBindingError(error));
				assert.equal(error.code, "filesystem-failed");
				assert.deepEqual(error.fields, { operation: "read", path, errno: "EACCES" });
			} finally {
				chmodSync(path, 0o755);
			}
		},
	);

	// POSIX: the pause is a FIFO.
	test.skipIf(process.platform === "win32")(
		"a worktree removed while its lock is read is added again, not used as complete (#4429)",
		async () => {
			const repo = createRepository(dirs.root, "removed-meanwhile");
			const path = join(dirs.root, "removed-meanwhile-worktree");
			git(repo, "worktree", "add", "-q", "-b", "feat/gone", path);
			const adminDir = git(path, "rev-parse", "--absolute-git-dir");
			const pause = pauseLockRead(adminDir);
			const { result, commands } = await countGitCommands(async () => {
				const binding = resolveWorkspace(workspace({ repo, branch: "feat/gone", worktree: path }));
				await pause.reading;
				rmSync(path, { recursive: true });
				rmSync(adminDir, { recursive: true });
				await pause.release();
				return binding;
			});
			assert.equal(result.worktree, realpathSync(path));
			assert.equal(countOf(commands, "worktree", "add"), 1);
			assertCompleteWorktree(path, result.tree);
		},
	);

	test.skipIf(process.platform === "win32")(
		"a worktree removed and added again while its lock is read waits for that addition (#4429)",
		async () => {
			const repo = createRepository(dirs.root, "added-again");
			const path = join(dirs.root, "added-again-worktree");
			git(repo, "worktree", "add", "-q", "-b", "feat/again", path);
			const adminDir = git(path, "rev-parse", "--absolute-git-dir");
			const pause = pauseLockRead(adminDir);
			const adder = await liveProcess();
			try {
				const { result: error, commands } = await countGitCommands(async () => {
					const binding = rejection(resolveWorkspace(workspace({ repo, branch: "feat/again", worktree: path })));
					await pause.reading;
					rmSync(path, { recursive: true });
					rmSync(adminDir, { recursive: true });
					interruptedWorktree(repo, path, "feat/again", WORKTREE_ADDING_REASON, { newBranch: false });
					recordAdder(repo, path, { host: hostname(), pid: adder.pid!, startTime: null });
					await pause.release();
					return binding;
				});
				assert.ok(isWorkspaceBindingError(error), String(error));
				assert.equal(error.reason, "addition-in-progress");
				assert.equal(error.fields.adderPid, adder.pid);
				assert.equal(countOf(commands, "worktree", "remove"), 0);
			} finally {
				await stopProcess(adder);
			}
		},
	);

	// POSIX: the stand-in git whose first listing fails is a shell script.
	test.skipIf(process.platform === "win32")(
		"a worktree listing git fails while a worktree is removed is taken again under the repository lock (#4429)",
		async () => {
			const repo = createRepository(dirs.root, "listing");
			const events: string[] = [];
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			let locked!: () => void;
			const holding = new Promise<void>((resolve) => {
				locked = resolve;
			});
			const holder = withRepositoryLock(realpathSync(join(repo, ".git")), async () => {
				locked();
				await released;
				events.push("lock released");
			});
			await holding;
			const stop = observeWorkspaceGitCommands((command) => {
				if (command.args[0] === "worktree" && command.args[1] === "list") events.push("worktree list");
			});
			try {
				const binding = await withInjectedGit(
					dirs.root,
					{ FAKE_GIT_MODE: "list-fails-once", FAKE_GIT_MARKER: join(dirs.root, "listed-once") },
					async () => {
						const pending = resolveWorkspace(workspace({ repo, branch: "feat/listed" }));
						while (!events.includes("worktree list")) await new Promise((resolve) => setTimeout(resolve, 10));
						await new Promise((resolve) => setTimeout(resolve, 200));
						release();
						await holder;
						return pending;
					},
				);
				assert.equal(binding.worktree, realpathSync(autoWorktree(repo, "feat/listed")));
				assert.deepEqual(events, ["worktree list", "lock released", "worktree list"]);
			} finally {
				stop();
				release();
			}
		},
	);

	test("a worktree listing that fails for a reason other than git's exit is not taken again (#4429)", async () => {
		const repo = createRepository(dirs.root, "listing-unavailable");
		const unavailable = new GitUnavailableError({
			code: "not-installed",
			platform: process.platform,
			arch: process.arch,
			installDir: "/opt/git",
			systemGit: { path: "git", problem: "probe-failed" },
		});
		let failNextCommand = false;
		const stop = observeWorkspaceGitCommands((command) => {
			if (command.args[0] === "rev-parse" && command.args.includes("--show-toplevel")) failNextCommand = true;
		});
		const restore = setWorkspaceGitExecutableResolver(async () => {
			if (!failNextCommand) return { path: "git", env: {} };
			failNextCommand = false;
			throw unavailable;
		});
		try {
			const { result: error, commands } = await countGitCommands(() =>
				rejection(resolveWorkspace(workspace({ repo, branch: "feat/unlisted" }))),
			);
			assert.ok(isWorkspaceBindingError(error), String(error));
			assert.equal(error.code, "git-unavailable");
			assert.equal(error.cause, unavailable);
			assert.equal(countOf(commands, "worktree", "list"), 0);
		} finally {
			restore();
			stop();
		}
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"an adder record that cannot be read fails with filesystem-failed, not as if no git were adding (#4429)",
		async () => {
			const repo = createRepository(dirs.root, "unreadable-record");
			const path = autoWorktree(repo, "feat/unreadable-record");
			recordAdder(repo, path, { host: hostname(), pid: process.pid, startTime: null });
			const record = worktreeAdderRecord(realpathSync(join(repo, ".git")), path);
			chmodSync(record, 0o000);
			try {
				const { result: error, commands } = await countGitCommands(() =>
					rejection(resolveWorkspace(workspace({ repo, branch: "feat/unreadable-record" }))),
				);
				assert.ok(isWorkspaceBindingError(error), String(error));
				assert.equal(error.code, "filesystem-failed");
				assert.deepEqual(error.fields, { operation: "read", path: record, errno: "EACCES" });
				assert.equal(countOf(commands, "worktree", "add"), 0);
			} finally {
				chmodSync(record, 0o644);
			}
		},
	);

	test("a worktree that disappears before it is resolved fails with filesystem-failed (#4429)", async () => {
		const repo = createRepository(dirs.root, "vanished");
		const missing = join(dirs.root, "vanished-worktree");
		const error = await rejection(
			verifyWorktree({ commonDir: realpathSync(join(repo, ".git")) }, repo, missing, "main"),
		);
		assert.ok(isWorkspaceBindingError(error), String(error));
		assert.equal(error.code, "filesystem-failed");
		assert.deepEqual(error.fields, { operation: "resolve", path: missing, errno: "ENOENT" });
	});
});

describe("workspace git phases (#3109)", () => {
	test("runs every git command of a binding in its phase, network ones as clone or fetch (#3109)", async () => {
		const remote = createRemote(dirs.root, "phases");
		const store = sharedStorePath(classifyRepository(remote.url) as never);
		const worktrees = join(dirs.home, "worktrees", "file", basename(store, ".git"));
		const record = transcriptOf({
			url: remote.url,
			store,
			"feat/x": join(worktrees, "feat", "x"),
			main: join(worktrees, "main"),
		});
		const fresh = await record(() => resolveWorkspace(workspace({ repo: remote.url, branch: "feat/x" })));
		const snapshot = [
			"probe: rev-parse --show-toplevel --git-common-dir",
			"probe: symbolic-ref --short HEAD",
			"snapshot: rev-parse HEAD",
			"snapshot: read-tree HEAD",
			"snapshot: add --all",
			"snapshot: write-tree",
			"probe: config --get-regexp ^remote\\..*\\.url$",
			"probe: merge-base <sha> HEAD",
		];
		assert.deepEqual(fresh.transcript, [
			"clone: init --bare <store>.tmp-<uuid>",
			"clone: remote add origin <url>",
			"fetch: fetch origin",
			"fetch: remote set-head origin --auto",
			"probe: symbolic-ref --short refs/remotes/origin/HEAD",
			"validate: worktree list --porcelain",
			"probe: rev-parse --verify origin/main^{commit}",
			"worktree-add: worktree prune",
			"probe: rev-parse --verify refs/heads/feat/x^{commit}",
			"probe: rev-parse --verify refs/remotes/origin/feat/x^{commit}",
			"worktree-add: worktree add --lock --reason atomic workspace: adding -b feat/x <feat/x> <sha>",
			"worktree-add: worktree unlock <feat/x>",
			...snapshot,
		]);
		const existing = await record(() => resolveWorkspace(workspace({ repo: remote.url, branch: "main" })));
		assert.deepEqual(existing.transcript, [
			"probe: symbolic-ref --short refs/remotes/origin/HEAD",
			"validate: worktree list --porcelain",
			"fetch: fetch --prune origin",
			"probe: rev-parse --verify origin/main^{commit}",
			"worktree-add: worktree prune",
			"probe: rev-parse --verify refs/heads/main^{commit}",
			"probe: rev-parse --verify refs/remotes/origin/main^{commit}",
			"worktree-add: worktree add --lock --reason atomic workspace: adding -b main <main> <sha>",
			"worktree-add: worktree unlock <main>",
			...snapshot,
		]);
		const fetched = await record(() => resolveWorkspace(workspace({ repo: remote.url, branch: "feat/y" })));
		assert.deepEqual(fetched.transcript.slice(0, 3), [
			"probe: symbolic-ref --short refs/remotes/origin/HEAD",
			"validate: worktree list --porcelain",
			"fetch: fetch --prune origin",
		]);
		commitFile(existing.result.worktree, "change.txt", "change\n");
		const changes = await record(() => workspaceChangeSet(existing.result));
		assert.deepEqual(changes.transcript, [
			"change-set: rev-parse HEAD",
			"change-set: diff --numstat --no-renames <sha> <sha>",
		]);
	});

	test("restores a deleted worktree with a network fetch and local worktree commands (#3109)", async () => {
		const remote = createRemote(dirs.root, "restore-phases");
		const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "main" }));
		rmSync(binding.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		const record = transcriptOf({ worktree: binding.worktree });
		const { transcript } = await record(() => restoreWorkspace(binding));
		assert.deepEqual(transcript, [
			"fetch: fetch --prune origin",
			"worktree-add: worktree prune",
			"probe: rev-parse --verify refs/heads/main^{commit}",
			"probe: rev-parse --verify refs/remotes/origin/main^{commit}",
			"worktree-add: worktree add --lock --reason atomic workspace: adding <worktree> main",
			"worktree-add: worktree unlock <worktree>",
			"probe: rev-parse --show-toplevel --git-common-dir",
			"probe: symbolic-ref --short HEAD",
			"validate: merge-base --is-ancestor <sha> HEAD",
			"probe: config --get-regexp ^remote\\..*\\.url$",
		]);
		git(binding.worktree, "reset", "-q", "--hard", "HEAD");
		git(binding.worktree, "commit", "-q", "--amend", "-m", "rewritten");
		const drift = await record(() => rejection(restoreWorkspace(binding)));
		assert.ok(isWorkspaceBindingError(drift.result));
		assert.equal(drift.result.code, "drift");
		assert.deepEqual(drift.transcript.slice(-2), [
			"validate: merge-base --is-ancestor <sha> HEAD",
			"validate: rev-parse HEAD",
		]);
	});

	test("fails fast on a missing repository path without running git in it (#3109)", async () => {
		const { result, commands } = await countGitCommands(() =>
			rejection(resolveWorkspace(workspace({ repo: join(dirs.root, "absent") }))),
		);
		assert.ok(isWorkspaceBindingError(result));
		assert.equal(result.reason, "not-a-repository");
		assert.deepEqual(
			commands.filter((args) => args[0] !== "--version"),
			[],
		);
	});

	test("reports a store directory it cannot create as a typed filesystem failure before cloning (#3109)", async () => {
		const remote = createRemote(dirs.root, "unwritable-home");
		writeFileSync(join(dirs.home, "repos"), "a file where the store directory belongs\n");
		const { result, commands } = await countGitCommands(() =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(result));
		assert.equal(result.code, "filesystem-failed");
		assert.equal(result.fields.operation, "create directory");
		assert.equal(result.fields.errno, "ENOTDIR");
		assert.equal(result.fields.path, dirname(sharedStorePath(classifyRepository(remote.url) as never)));
		assert.equal(result.retryable, false);
		assert.equal((result.cause as NodeJS.ErrnoException).code, "ENOTDIR");
		assert.deepEqual(
			commands.filter((args) => args[0] !== "--version"),
			[],
			"nothing was cloned",
		);
	});

	test("reports a leftover store directory with content as in the way instead of overwriting it (#3109)", async () => {
		const remote = createRemote(dirs.root, "occupied-store");
		const store = sharedStorePath(classifyRepository(remote.url) as never);
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "unrelated.txt"), "not a git store\n");
		const error = await rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" })));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.code, "filesystem-failed");
		assert.equal(error.fields.operation, "move clone to");
		assert.equal(error.fields.path, store);
		assert.deepEqual(readdirSync(store), ["unrelated.txt"], "the leftover content is untouched");
		if (process.platform !== "win32") assert.equal(error.hint, `Remove ${store}, which is in the way, then retry.`);
	});

	test("derives the branch from a remote base by dropping only a leading origin/ (#3109)", async () => {
		const remote = createRemote(dirs.root, "base-branches");
		const bare = remote.url.replace(/^file:\/\//, "");
		git(remote.seed, "push", "-q", bare, "HEAD:refs/heads/release");
		git(remote.seed, "push", "-q", bare, "HEAD:refs/heads/upstream/origin/x");
		const release = await resolveWorkspace(workspace({ repo: remote.url, base: "origin/release" }));
		assert.equal(release.branch, "release");
		const nested = await resolveWorkspace(workspace({ repo: remote.url, base: "upstream/origin/x" }));
		assert.equal(nested.branch, "upstream/origin/x");
	});

	test("a waiter's abort listener is removed when the shared clone settles either way (#3109)", async () => {
		const remote = createRemote(dirs.root, "listeners");
		const controller = new AbortController();
		await resolveWorkspace(workspace({ repo: remote.url, branch: "one" }), { signal: controller.signal });
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		const url = `file://${join(dirs.root, "missing-remote.git")
			.replaceAll("\\", "/")
			.replace(/^(?=[A-Za-z]:)/, "/")}`;
		const failed = await rejection(
			resolveWorkspace(workspace({ repo: url, branch: "x" }), { signal: controller.signal }),
		);
		assert.ok(isWorkspaceBindingError(failed));
		assert.equal(failed.fields.phase, "fetch");
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});
});

// POSIX: the fake git is a shell script.
describe.skipIf(process.platform === "win32")("workspace resolution under injected git failures (#3109)", () => {
	function withFakeGit<T>(mode: string, body: () => Promise<T>): Promise<T> {
		return withInjectedGit(dirs.root, { FAKE_GIT_MODE: mode }, body);
	}

	function storeParent(url: string): string {
		const remote = classifyRepository(url);
		assert.ok(remote?.kind === "remote");
		return dirname(sharedStorePath(remote));
	}

	test("removes a staging clone whose fetch failed and reports the fetch (#3109)", async () => {
		const remote = createRemote(dirs.root, "staging-fetch");
		const error = await withFakeGit("staging-fetch", () =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.phase, "fetch");
		assert.equal(error.fields.detail, "injected fetch failure");
		assert.equal(error.cleanupCause, undefined);
		assert.deepEqual(readdirSync(storeParent(remote.url)), []);
	});

	test("keeps the fetch failure primary when the staging clone cannot be removed (#3109)", async () => {
		const remote = createRemote(dirs.root, "unremovable-staging");
		const error = await withFakeGit("unremovable-staging", () =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.detail, "injected fetch failure");
		assert.equal((error.cleanupCause as NodeJS.ErrnoException | undefined)?.code, "ENOTDIR");
	});

	test("uses the store a concurrent clone completed when its own clone failed (#3109)", async () => {
		const remote = createRemote(dirs.root, "winner-store");
		const binding = await withFakeGit("winner-store", () =>
			resolveWorkspace(workspace({ repo: remote.url, branch: "x" })),
		);
		assert.equal(binding.repository, realpathSync(sharedStorePath(classifyRepository(remote.url) as never)));
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), git(remote.seed, "rev-parse", "HEAD"));
	});

	test("does not mistake a store directory without HEAD for a completed clone (#3109)", async () => {
		const remote = createRemote(dirs.root, "empty-store");
		const error = await withFakeGit("empty-store", () =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.detail, "injected fetch failure");
	});

	test("replaces an empty leftover store directory with a fresh clone (#3109)", async () => {
		const remote = createRemote(dirs.root, "leftover-store");
		const store = sharedStorePath(classifyRepository(remote.url) as never);
		mkdirSync(store, { recursive: true });
		const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "x" }));
		assert.equal(existsSync(join(store, "HEAD")), true);
		assert.equal(git(binding.worktree, "rev-parse", "HEAD"), git(remote.seed, "rev-parse", "HEAD"));
	});

	test("a store whose creation fails before it exists leaves nothing to clean up (#3109)", async () => {
		const remote = createRemote(dirs.root, "init-fails");
		const error = await withFakeGit("init-fails", () =>
			rejection(resolveWorkspace(workspace({ repo: remote.url, branch: "x" }))),
		);
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.phase, "clone");
		assert.equal(error.fields.detail, "injected init failure");
		assert.equal(error.cleanupCause, undefined);
	});

	test("a snapshot that fails before its index exists reports the git failure, not the index cleanup (#3109)", async () => {
		const repo = createRepository(dirs.root, "read-tree");
		const error = await withFakeGit("read-tree", () => rejection(resolveWorkspace(workspace({ repo }))));
		assert.ok(isWorkspaceBindingError(error));
		assert.equal(error.fields.phase, "snapshot");
		assert.equal(error.fields.detail, "injected read-tree failure");
	});

	test("a second resolution waits for a worktree another one is still adding (#3109)", async () => {
		const remote = createRemote(dirs.root, "slow-add");
		await resolveWorkspace(workspace({ repo: remote.url, branch: "main" }));
		const store = sharedStorePath(classifyRepository(remote.url) as never);
		const target = join(dirs.home, "worktrees", "file", basename(store, ".git"), "race");
		await withFakeGit("slow-worktree-add", async () => {
			const first = resolveWorkspace(workspace({ repo: remote.url, branch: "race" }));
			while (!existsSync(target)) await new Promise((resolve) => setTimeout(resolve, 10));
			const second = resolveWorkspace(workspace({ repo: remote.url, branch: "race" }));
			const [a, b] = await Promise.all([first, second]);
			assert.equal(a.worktree, realpathSync(target));
			assert.equal(b.worktree, a.worktree);
		});
	});
});
