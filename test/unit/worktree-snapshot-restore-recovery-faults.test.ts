import assert from "node:assert/strict";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { startHostProcessesThroughChildProcess } from "../helpers/host-spawn.js";
import type {
	LockOptions,
	RealLock,
	Release,
	SpawnedGit,
	SpawnOverride,
} from "./worktree-snapshot-restore-recovery-faults-helpers.js";

const faults = vi.hoisted(() => ({
	spawns: [] as SpawnedGit[],
	spawnHook: undefined as
		| undefined
		| ((args: readonly string[], cwd: string, env: Record<string, string | undefined>) => SpawnOverride | undefined),
	lstat: undefined as undefined | ((path: string) => void),
	realpath: undefined as undefined | ((path: string) => void),
	writeFile: undefined as undefined | ((path: string) => void),
	rm: undefined as undefined | ((path: string) => void),
	lock: undefined as undefined | ((file: string, options: LockOptions, real: RealLock) => Promise<Release>),
	uuids: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (
			command: string,
			args: readonly string[],
			options: { cwd?: string; env?: Record<string, string | undefined> },
		) => {
			const cwd = String(options?.cwd);
			const env = options?.env ?? {};
			faults.spawns.push({ args, cwd, env });
			const override = faults.spawnHook?.(args, cwd, env);
			return (actual.spawn as (...parameters: unknown[]) => unknown)(
				override?.command ?? command,
				override?.args ?? args,
				options,
			);
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (path: string, ...rest: unknown[]) => {
			faults.lstat?.(String(path));
			return (actual.lstat as (...parameters: unknown[]) => Promise<unknown>)(path, ...rest);
		},
		realpath: async (path: string, ...rest: unknown[]) => {
			faults.realpath?.(String(path));
			return (actual.realpath as (...parameters: unknown[]) => Promise<unknown>)(path, ...rest);
		},
		writeFile: async (path: string, ...rest: unknown[]) => {
			faults.writeFile?.(String(path));
			return (actual.writeFile as (...parameters: unknown[]) => Promise<void>)(path, ...rest);
		},
		rm: async (path: string, ...rest: unknown[]) => {
			faults.rm?.(String(path));
			return (actual.rm as (...parameters: unknown[]) => Promise<void>)(path, ...rest);
		},
	};
});

vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<{ default?: { lock: RealLock } & Record<string, unknown>; lock?: RealLock }>();
	const real = (actual.default ?? actual) as { lock: RealLock } & Record<string, unknown>;
	return {
		default: {
			...real,
			lock: (file: string, options: LockOptions) =>
				faults.lock ? faults.lock(file, options, real.lock.bind(real)) : real.lock(file, options),
		},
	};
});

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, randomUUID: () => faults.uuids.shift() ?? actual.randomUUID() };
});

import {
	isWorkspaceGitError,
	isWorkspaceRestoreError,
	removeRestoredWorktree,
	restoreWorktree,
	type WorktreeRestoreWarning,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";
import {
	asideOf,
	dirtyCloneIn,
	failAtCheckoutWith,
	is,
	lists,
	registeredIn,
	resetFaultState,
	restoreInto,
	retainedWarnings,
	siblingStaging,
	stagingOf,
	storeOf,
	uuid,
	warning,
} from "./worktree-snapshot-restore-recovery-faults-helpers.js";

/**
 * Faults at exact moments of a restore and of the sweep that cleans up after one: a Git command is replaced or given
 * a side effect, a filesystem call fails, a lock is lost or fails to release. The code under test runs for real; only
 * the failure is scripted. Everything the sweep and the restore report is asserted: typed errors, causes, warnings.
 */

startHostProcessesThroughChildProcess();

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
	resetFaultState(faults);
});
afterEach(() => sandbox.dispose());

const dirtyClone = (files?: Record<string, string>) => dirtyCloneIn(sandbox, files);
const registered = (store: string) => registeredIn(sandbox, store);
const failAtCheckout = (controller: AbortController, reason: unknown, beforeAbort?: () => void) =>
	failAtCheckoutWith(faults, controller, reason, beforeAbort);

describe("a restore whose process lost its lock", () => {
	test("fails with the staging lock lost, cleans up its staging worktree and leaves no record", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const into = sandbox.path("final");
		const lost = Object.assign(new Error("lock lost"), { code: "ECOMPROMISED" });
		let staging = "";
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
			if (!file.endsWith(".json")) return release;
			faults.spawnHook = (args) => {
				if (is(args, "worktree", "add")) {
					staging = stagingOf(args);
					options.onCompromised(lost);
				}
				return undefined;
			};
			return release;
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(isWorkspaceGitError(error), String(error));
		assert.equal(error.operation, "worktree restore");
		assert.equal(error.detail, "the staging lock was lost");
		assert.equal(error.cwd, staging);
		assert.equal(error.exitCode, null);
		assert.equal(error.cause, lost);
		assert.deepEqual(retainedWarnings(warnings), []);
		assert.equal(existsSync(into), false);
		assert.equal(existsSync(staging), false);
		assert.equal(lists(await registered(storeOf(storeDir, snapshot)), staging), false);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
	});

	for (const written of ["nothing", "the first bytes"] as const) {
		test(`a stop while Git has written ${written} of a file into the checkout still removes the worktree (#4748)`, async () => {
			const { snapshot, blobs } = await dirtyClone();
			const storeDir = sandbox.path("host");
			const reason = new Error("stop restoring");
			const controller = new AbortController();
			faults.spawnHook = (args, cwd) => {
				if (is(args, "read-tree", "--reset", "-u")) {
					// Git is killed after it created the file and before it finished writing it.
					writeFileSync(join(cwd, "dirty.txt"), written === "nothing" ? "" : "reco");
					queueMicrotask(() => controller.abort(reason));
					return { command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] };
				}
				return undefined;
			};

			const { error, warnings } = await restoreInto(
				snapshot,
				blobs,
				storeDir,
				sandbox.path("final"),
				controller.signal,
			);

			assert.equal(error, reason);
			assert.equal((error as { cleanupCause?: unknown }).cleanupCause, undefined);
			assert.deepEqual(retainedWarnings(warnings), []);
			assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
			assert.deepEqual(
				readdirSync(sandbox.root).filter((name) => /\.final\.[sd]-/.test(name)),
				[],
			);
		});
	}

	test("a file in the restore's own worktree that is not a beginning of what checkout writes is kept (#4748)", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const reason = new Error("stop restoring");
		const controller = new AbortController();
		let staging = "";
		faults.spawnHook = (args, cwd) => {
			if (is(args, "read-tree", "--reset", "-u")) {
				staging = cwd;
				writeFileSync(join(cwd, "dirty.txt"), "recX");
				queueMicrotask(() => controller.abort(reason));
				return { command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] };
			}
			return undefined;
		};

		const { error, warnings } = await restoreInto(
			snapshot,
			blobs,
			storeDir,
			sandbox.path("final"),
			controller.signal,
		);

		assert.equal(error, reason);
		assert.equal(readFileSync(join(asideOf(staging), "dirty.txt"), "utf8"), "recX");
		assert.deepEqual(retainedWarnings(warnings), [warning(asideOf(staging))]);
	});

	test("also stops as soon as its signal is aborted, with the abort reason", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const reason = new Error("stop restoring");
		const controller = new AbortController();
		failAtCheckout(controller, reason);

		const { error } = await restoreInto(snapshot, blobs, storeDir, sandbox.path("final"), controller.signal);

		assert.equal(error, reason);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
		assert.deepEqual(
			readdirSync(sandbox.root).filter((name) => name.includes("atomic-restore")),
			[],
		);
	});
});

describe("the record a restore writes", () => {
	test.skipIf(process.platform === "win32")(
		"is private to its owner while the restore runs (POSIX modes, which Windows files do not have)",
		async () => {
			const { snapshot, blobs } = await dirtyClone();
			const storeDir = sandbox.path("host");
			const modes: number[] = [];
			faults.spawnHook = (args) => {
				if (is(args, "worktree", "add")) {
					for (const name of readdirSync(join(storeDir, "restores")))
						if (name.endsWith(".json")) modes.push(statSync(join(storeDir, "restores", name)).mode & 0o077);
				}
				return undefined;
			};
			await restoreInto(snapshot, blobs, storeDir, sandbox.path("final"));
			assert.deepEqual(modes, [0], "neither group nor others can read or write the record");
		},
	);

	test("is created exclusively, so a record path someone planted as a symlink is never written through", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const id = uuid();
		const victim = sandbox.path("victim.txt");
		writeFileSync(victim, "precious\n");
		mkdirSync(join(storeDir, "restores"), { recursive: true });
		symlinkSync(victim, join(storeDir, "restores", `${id}.json`));
		faults.uuids.push(id);

		const { error } = await restoreInto(snapshot, blobs, storeDir, sandbox.path("final"));

		assert.ok(isWorkspaceRestoreError(error), String(error));
		assert.equal(error.code, "unwritable-path");
		assert.equal(error.target, join(storeDir, "restores", `${id}.json`));
		assert.equal((error.cause as NodeJS.ErrnoException).code, "EEXIST");
		assert.equal(readFileSync(victim, "utf8"), "precious\n");
		assert.equal(error.cleanupCause, undefined);
	});

	test("that cannot be written fails the restore as an unwritable path, with nothing to clean up", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		faults.writeFile = (path) => {
			if (/[\\/]restores[\\/]/.test(path) && path.endsWith(".json")) {
				throw Object.assign(new Error(`ENOSPC: no space left on device, open '${path}'`), {
					code: "ENOSPC",
					syscall: "open",
					path,
				});
			}
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, sandbox.path("final"));

		assert.ok(isWorkspaceRestoreError(error), String(error));
		assert.equal(error.code, "unwritable-path");
		assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOSPC");
		assert.equal(error.cleanupCause, undefined);
		assert.deepEqual(warnings, []);
		assert.deepEqual(
			readdirSync(sandbox.root).filter((name) => name.includes("atomic-restore")),
			[],
		);
	});

	test("that cannot be removed after a successful restore is reported as retained, and the restore still succeeds", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		faults.rm = (path) => {
			if (/[\\/]restores[\\/]/.test(path) && path.endsWith(".json")) {
				throw Object.assign(new Error(`EBUSY: resource busy, rm '${path}'`), {
					code: "EBUSY",
					syscall: "rm",
					path,
				});
			}
		};

		const { restored, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.equal(restored?.path, into);
		assert.equal(readFileSync(join(into, "dirty.txt"), "utf8"), "recorded\n");
		assert.deepEqual(retainedWarnings(warnings), [warning(siblingStaging(into, id))]);
	});

	test("left behind by a successful restore is swept later without touching the worktree it published or work done in it since", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const into = sandbox.path("final");
		faults.rm = (path) => {
			if (/[\\/]restores[\\/]/.test(path) && path.endsWith(".json")) {
				throw Object.assign(new Error(`EBUSY: resource busy, rm '${path}'`), {
					code: "EBUSY",
					syscall: "rm",
					path,
				});
			}
		};
		const { restored } = await restoreInto(snapshot, blobs, storeDir, into);
		assert.equal(restored?.path, into);
		assert.equal(readdirSync(join(storeDir, "restores")).length, 1, "the record is left behind");
		faults.rm = undefined;
		writeFileSync(join(into, "later.txt"), "work done after the restore\n");

		const next = await restoreInto(snapshot, blobs, storeDir, sandbox.path("other"));

		assert.equal(next.error, undefined);
		assert.deepEqual(retainedWarnings(next.warnings), []);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), [], "the sweep removed the record");
		assert.equal(readFileSync(join(into, "later.txt"), "utf8"), "work done after the restore\n");
		assert.equal(readFileSync(join(into, "dirty.txt"), "utf8"), "recorded\n");
		assert.ok(lists(await registered(storeOf(storeDir, snapshot)), into), "the worktree is still registered");
	});
});

describe("sweeping a record left by a stopped restore", () => {
	/**
	 * A restore stopped at its checkout whose cleanup could not finish: its staging worktree, Git's entry for it and its
	 * crash record stay behind for the next sweep.
	 */
	async function leftBehind(files?: Record<string, string>) {
		const { snapshot, blobs } = await dirtyClone(files);
		const storeDir = sandbox.path("host");
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const staging = siblingStaging(into, id);
		const controller = new AbortController();
		let stopped = false;
		// Stopped once the checkout is complete, as the restore records its index.
		faults.spawnHook = (args) => {
			if (!stopped && is(args, "update-index")) {
				stopped = true;
				queueMicrotask(() => controller.abort(new Error("stop")));
			}
			return undefined;
		};
		faults.realpath = (path) => {
			if (stopped && path === staging) {
				throw Object.assign(new Error(`EIO: i/o error, realpath '${path}'`), {
					code: "EIO",
					syscall: "realpath",
					path,
				});
			}
		};
		const outcome = await restoreInto(snapshot, blobs, storeDir, into, controller.signal);
		assert.ok(outcome.error instanceof Error);
		assert.equal(readdirSync(join(storeDir, "restores")).filter((name) => name.endsWith(".json")).length, 1);
		assert.equal(existsSync(join(staging, "dirty.txt")), true);
		faults.realpath = undefined;
		faults.spawnHook = undefined;
		return { snapshot, blobs, storeDir, store: storeOf(storeDir, snapshot), staging };
	}

	/** The user moves the restore's staging directory away and puts a directory of their own at its path. */
	function replaceStaging(staging: string, copies: readonly string[]): void {
		const moved = sandbox.path("moved-away");
		renameSync(staging, moved);
		mkdirSync(staging);
		for (const name of copies) copyFileSync(join(moved, name), join(staging, name));
		writeFileSync(join(staging, "keep.txt"), "user data\n");
	}

	test("a directory of the user's at the staging path, holding a copy of the old .git file, is kept with its files (#4748)", async () => {
		const { snapshot, blobs, storeDir, staging } = await leftBehind();
		replaceStaging(staging, [".git"]);

		const next = await restoreInto(snapshot, blobs, storeDir, sandbox.path("other"));

		assert.equal(next.error, undefined);
		assert.equal(readFileSync(join(staging, "keep.txt"), "utf8"), "user data\n");
		assert.equal(existsSync(join(staging, ".git")), true);
		assert.deepEqual(retainedWarnings(next.warnings), [warning(staging)]);
	});

	test("one that also holds copies of every file the restore put there is kept with its files too (#4748)", async () => {
		const { snapshot, blobs, storeDir, staging } = await leftBehind();
		replaceStaging(staging, [".git", "dirty.txt", "README.md"]);

		const next = await restoreInto(snapshot, blobs, storeDir, sandbox.path("other"));

		assert.equal(next.error, undefined);
		assert.equal(readFileSync(join(staging, "keep.txt"), "utf8"), "user data\n");
		assert.equal(readFileSync(join(staging, "dirty.txt"), "utf8"), "recorded\n");
		assert.deepEqual(retainedWarnings(next.warnings), [warning(staging)]);
	});

	test("even with no file of the user's in it, a directory of copies is not the restore's and is kept (#4748)", async () => {
		const { snapshot, blobs, storeDir, staging } = await leftBehind();
		replaceStaging(staging, [".git", "dirty.txt", "README.md"]);
		rmSync(join(staging, "keep.txt"));

		const next = await restoreInto(snapshot, blobs, storeDir, sandbox.path("other"));

		assert.equal(next.error, undefined);
		assert.deepEqual(readdirSync(staging).sort(), [".git", "README.md", "dirty.txt"]);
		assert.deepEqual(retainedWarnings(next.warnings), [warning(staging)]);
	});

	test("the restore's own staging worktree is still swept, also once moved away and back (#4748)", async () => {
		const { snapshot, blobs, storeDir, store, staging } = await leftBehind();
		const away = sandbox.path("away-and-back");
		renameSync(staging, away);
		renameSync(away, staging);

		const next = await restoreInto(snapshot, blobs, storeDir, sandbox.path("other"));

		assert.equal(next.error, undefined);
		assert.deepEqual(retainedWarnings(next.warnings), []);
		assert.equal(existsSync(staging), false);
		assert.equal(existsSync(asideOf(staging)), false);
		assert.equal(lists(await registered(store), staging), false);
		assert.deepEqual(
			readdirSync(join(storeDir, "restores")).filter((name) => name.endsWith(".json")),
			[],
		);
	});

	test("an edit a clean filter would drop is kept: a file counts as the snapshot's only with the bytes checkout writes (#4748)", async () => {
		appendFileSync(sandbox.globalConfig, '[filter "redact"]\n\tclean = sed s/secret=.*/secret=X/\n');
		const { snapshot, blobs, storeDir, staging } = await leftBehind({
			".gitattributes": "*.cfg filter=redact\n",
			"app.cfg": "secret=X\n",
		});
		writeFileSync(join(staging, "app.cfg"), "secret=hunter2\n");

		const next = await restoreInto(snapshot, blobs, storeDir, sandbox.path("other"));

		assert.equal(next.error, undefined);
		assert.equal(readFileSync(join(asideOf(staging), "app.cfg"), "utf8"), "secret=hunter2\n");
		assert.deepEqual(retainedWarnings(next.warnings), [warning(asideOf(staging))]);
	});

	test("a file an end-of-line rule converted at checkout is still the snapshot's, and is swept (#4748)", async () => {
		const { snapshot, blobs, storeDir, staging } = await leftBehind({
			".gitattributes": "*.txt text eol=crlf\n",
			"notes.txt": "one\ntwo\n",
		});
		assert.equal(readFileSync(join(staging, "notes.txt"), "utf8"), "one\r\ntwo\r\n");

		const next = await restoreInto(snapshot, blobs, storeDir, sandbox.path("other"));

		assert.equal(next.error, undefined);
		assert.deepEqual(retainedWarnings(next.warnings), []);
		assert.equal(existsSync(staging), false);
		assert.equal(existsSync(asideOf(staging)), false);
	});

	test("a file the user put into the restore's own staging worktree is kept, moved aside with the worktree (#4748)", async () => {
		const { snapshot, blobs, storeDir, staging } = await leftBehind();
		writeFileSync(join(staging, "keep.txt"), "user data\n");

		const next = await restoreInto(snapshot, blobs, storeDir, sandbox.path("other"));

		assert.equal(next.error, undefined);
		assert.equal(readFileSync(join(asideOf(staging), "keep.txt"), "utf8"), "user data\n");
		assert.deepEqual(retainedWarnings(next.warnings), [warning(asideOf(staging))]);
	});
});

describe("releasing the lock of a restore", () => {
	const releaseFailure = () => Object.assign(new Error("EIO: could not release"), { code: "EIO" });

	/** Wraps the lock a restore takes on its own record so that releasing it fails. */
	function failReleaseOfRestores(cause: Error): void {
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
			return async () => {
				await release();
				throw cause;
			};
		};
	}

	test("failing after a successful restore is reported as a retained leftover, not as a failed restore", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		failReleaseOfRestores(releaseFailure());

		const { restored, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.equal(restored?.path, into);
		assert.deepEqual(retainedWarnings(warnings), [warning(siblingStaging(into, id))]);
		assert.deepEqual(
			readdirSync(join(storeDir, "restores")).filter((name) => name.endsWith(".json")),
			[],
		);
	});

	test("failing after a failed restore is attached to that failure instead of replacing it", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const reason = new Error("stop");
		const release = releaseFailure();
		failReleaseOfRestores(release);
		const controller = new AbortController();
		failAtCheckout(controller, reason);

		const { error, warnings } = await restoreInto(
			snapshot,
			blobs,
			sandbox.path("host"),
			sandbox.path("final"),
			controller.signal,
		);

		assert.equal(error, reason);
		assert.equal((error as Error & { cleanupCause?: unknown }).cleanupCause, release);
		assert.deepEqual(retainedWarnings(warnings), []);
	});

	test("failing after a failed cleanup keeps the cleanup failure as the cause", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const reason = new Error("stop");
		failReleaseOfRestores(releaseFailure());
		const controller = new AbortController();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const staging = siblingStaging(into, id);
		failAtCheckout(controller, reason, () => {
			const victim = sandbox.path("victim");
			mkdirSync(victim);
			rmSync(staging, { recursive: true });
			symlinkSync(victim, staging, "dir");
		});

		const { error, warnings } = await restoreInto(snapshot, blobs, sandbox.path("host"), into, controller.signal);

		assert.equal(error, reason);
		const cleanup = (error as Error & { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceRestoreError(cleanup), String(cleanup));
		assert.equal(cleanup.code, "unsafe-target");
		assert.deepEqual(retainedWarnings(warnings), [warning(staging)]);
	});

	test("failing after a failure that is not an Error changes nothing about that failure and reports nothing", async () => {
		const { snapshot, blobs } = await dirtyClone();
		failReleaseOfRestores(releaseFailure());
		const controller = new AbortController();
		failAtCheckout(controller, "stop");

		const { error, warnings } = await restoreInto(
			snapshot,
			blobs,
			sandbox.path("host"),
			sandbox.path("final"),
			controller.signal,
		);

		assert.equal(error, "stop");
		assert.deepEqual(retainedWarnings(warnings), []);
	});
});

describe("sweeping a record under faults", () => {
	const HEX24 = "0123456789abcdef01234567";

	async function staleRecord(options: { createdTarget?: boolean } = {}) {
		const remote = (await sandbox.remoteWithClone()).remote;
		const head = await sandbox.git(sandbox.root, "--git-dir", remote, "rev-parse", "main");
		const storeDir = sandbox.path("host");
		const store = join(storeDir, "repositories", `${HEX24}.git`);
		mkdirSync(join(storeDir, "repositories"), { recursive: true });
		await sandbox.git(sandbox.root, "clone", "--bare", "-q", remote, store);
		const id = uuid();
		const staging = join(storeDir, "worktrees", `.staging-${id}`);
		await sandbox.git(
			sandbox.root,
			"--git-dir",
			store,
			"worktree",
			"add",
			"-q",
			"--detach",
			"--no-checkout",
			staging,
			head,
		);
		mkdirSync(join(storeDir, "restores"), { recursive: true });
		const record = join(storeDir, "restores", `${id}.json`);
		writeFileSync(
			record,
			JSON.stringify({
				staging,
				target: join(storeDir, "worktrees", "final"),
				store,
				createdTarget: options.createdTarget ?? true,
			}),
		);
		return { storeDir, store, staging, record, id };
	}

	async function sweep(storeDir: string): Promise<WorktreeRestoreWarning[]> {
		const warnings: WorktreeRestoreWarning[] = [];
		await removeRestoredWorktree(sandbox.path("nothing-to-remove"), {
			storeDir,
			onWarning: (reported) => warnings.push(reported),
		});
		return warnings;
	}

	test("a lock that fails for a reason other than being held is reported with the record's path", async () => {
		const { storeDir, record, staging } = await staleRecord();
		faults.lock = async () => {
			throw Object.assign(new Error("EIO: cannot lock"), { code: "EIO" });
		};

		assert.deepEqual(await sweep(storeDir), [warning(record, "record")]);

		assert.equal(existsSync(staging), true);
		assert.equal(existsSync(record), true);
	});

	test("a record that disappears between listing and locking is not reported", async () => {
		const { storeDir, record, staging } = await staleRecord();
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
			rmSync(record);
			return release;
		};

		assert.deepEqual(await sweep(storeDir), []);

		assert.equal(existsSync(staging), true, "a record that is gone is not a reason to remove its staging worktree");
	});

	test("a record that disappears while its staging is being cleaned up is still reported with the staging path", async () => {
		const { storeDir, record, staging } = await staleRecord();
		faults.spawnHook = (args) => {
			if (is(args, "worktree", "prune")) rmSync(record);
			return undefined;
		};

		assert.deepEqual(await sweep(storeDir), [warning(staging)]);

		assert.equal(existsSync(staging), false);
	});

	test("a lock lost during the cleanup keeps the record and reports the staging path", async () => {
		const { storeDir, record, staging } = await staleRecord();
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
			// The record's lock is the one lost, not the shared store's lock the cleanup also takes (#4951).
			if (file !== record) return release;
			faults.spawnHook = (args) => {
				if (is(args, "worktree", "prune")) {
					options.onCompromised(Object.assign(new Error("lock lost"), { code: "ECOMPROMISED" }));
				}
				return undefined;
			};
			return release;
		};

		assert.deepEqual(await sweep(storeDir), [warning(staging)]);

		assert.equal(existsSync(record), true);
	});

	test("a lock that cannot be released after a clean sweep is reported with the staging path", async () => {
		const { storeDir, record, staging } = await staleRecord();
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
			return async () => {
				await release();
				throw Object.assign(new Error("EIO: could not release"), { code: "EIO" });
			};
		};

		assert.deepEqual(await sweep(storeDir), [warning(staging)]);

		assert.equal(existsSync(staging), false);
		assert.equal(existsSync(record), false);
	});

	test("a lock that is lost while it is being released is not a second reason to report", async () => {
		const { storeDir, record, staging } = await staleRecord();
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
			return async () => {
				options.onCompromised(Object.assign(new Error("lock lost"), { code: "ECOMPROMISED" }));
				await release();
				throw Object.assign(new Error("Lock is already released"), { code: "ERELEASED" });
			};
		};

		assert.deepEqual(await sweep(storeDir), []);

		assert.equal(existsSync(staging), false);
		assert.equal(existsSync(record), false);
	});

	/** A record whose staging was swapped for a symlink (so its cleanup fails) and whose lock cannot be released. */
	async function brokenRecord() {
		const fixture = await staleRecord();
		const victim = sandbox.path("victim");
		mkdirSync(victim);
		writeFileSync(join(victim, "keep.txt"), "user data\n");
		writeFileSync(join(victim, ".git"), readFileSync(join(fixture.staging, ".git")));
		rmSync(fixture.staging, { recursive: true });
		symlinkSync(victim, fixture.staging, "dir");
		mkdirSync(`${fixture.record}.lock`);
		const past = new Date(Date.now() - 120_000);
		utimesSync(`${fixture.record}.lock`, past, past);
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
			if (file !== fixture.record) return release;
			return async () => {
				await release();
				throw Object.assign(new Error("EIO: could not release"), { code: "EIO" });
			};
		};
		return { ...fixture, victim };
	}

	test("a leftover that fails to clean up and to unlock is reported once by a removal", async () => {
		const { storeDir, staging, victim } = await brokenRecord();

		assert.deepEqual(await sweep(storeDir), [warning(staging)]);

		assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "user data\n");
	});

	test("a leftover that fails to clean up and to unlock is reported once by a restore", async () => {
		const { storeDir, staging, victim } = await brokenRecord();
		const { snapshot, blobs } = await dirtyClone();

		const { restored, warnings } = await restoreInto(snapshot, blobs, storeDir, sandbox.path("final"));

		assert.ok(restored);
		assert.deepEqual(retainedWarnings(warnings), [warning(staging)]);
		assert.equal(retainedWarnings(restored.warnings).length, 1);
		assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "user data\n");
	});
});

describe("what a removal runs against", () => {
	test("both the removal and the pruning that follows it run against the shared store, never the process's own repository", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const restored = await restoreWorktree(snapshot, { blobs, storeDir });
		const store = storeOf(storeDir, snapshot);
		faults.spawns.length = 0;

		await removeRestoredWorktree(restored.path, { storeDir });

		const removal = faults.spawns.filter((spawned) => is(spawned.args, "worktree", "remove"));
		const pruning = faults.spawns.filter((spawned) => is(spawned.args, "worktree", "prune"));
		assert.equal(removal.length, 1);
		assert.equal(pruning.length, 1);
		for (const spawned of [...removal, ...pruning]) {
			assert.equal(spawned.cwd, join(storeDir, "repositories"));
			assert.equal(spawned.env.GIT_DIR, store);
		}
		assert.equal(existsSync(restored.path), false);
	});
});
