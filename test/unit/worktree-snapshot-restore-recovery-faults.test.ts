import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

/** One Git process the code under test starts, and the hooks that let a test act at that exact moment. */
interface SpawnedGit {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Record<string, string | undefined>;
}
interface SpawnOverride {
	readonly command?: string;
	readonly args?: readonly string[];
}
interface LockOptions {
	readonly onCompromised: (error: Error) => void;
}
type Release = () => Promise<void>;
type RealLock = (file: string, options: LockOptions) => Promise<Release>;

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
	captureWorktreeSnapshot,
	isWorkspaceGitError,
	isWorkspaceRestoreError,
	isWorkspaceSnapshotError,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	restoreWorktree,
	type WorktreeRestoreWarning,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

/**
 * Faults at exact moments of a restore and of the sweep that cleans up after one: a Git command is replaced or given
 * a side effect, a filesystem call fails, a lock is lost or fails to release. The code under test runs for real; only
 * the failure is scripted. Everything the sweep and the restore report is asserted: typed errors, causes, warnings.
 */

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
	faults.spawns.length = 0;
	faults.spawnHook = undefined;
	faults.lstat = undefined;
	faults.realpath = undefined;
	faults.writeFile = undefined;
	faults.rm = undefined;
	faults.lock = undefined;
	faults.uuids.length = 0;
});
afterEach(() => sandbox.dispose());

/** A Git invocation's arguments past the leading `-c key=value` pairs. */
function command(args: readonly string[]): string[] {
	const rest: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (rest.length === 0 && args[index] === "-c") index++;
		else rest.push(args[index]!);
	}
	return rest;
}
const is = (args: readonly string[], ...prefix: string[]) =>
	prefix.every((word, index) => command(args)[index] === word);

async function dirtyClone(): Promise<{ readonly snapshot: WorktreeSnapshot; readonly blobs: MemorySnapshotBlobStore }> {
	const { clone } = await sandbox.remoteWithClone("work");
	sandbox.write(join(clone, "dirty.txt"), "recorded\n");
	const blobs = new MemorySnapshotBlobStore();
	const captured = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") throw new Error("capture failed");
	return { snapshot: captured.snapshot, blobs };
}

/** The shared store a restore of `snapshot` keeps under `storeDir`. */
function storeOf(storeDir: string, snapshot: WorktreeSnapshot): string {
	const name = createHash("sha256").update(snapshot.remotes.join("\n")).digest("hex").slice(0, 24);
	return join(storeDir, "repositories", `${name}.git`);
}

async function registered(store: string): Promise<string[]> {
	const listing = await sandbox.git(sandbox.root, "--git-dir", store, "worktree", "list", "--porcelain");
	return listing
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

const warning = (
	path: string,
	kind: "worktree" | "record" | "records-directory" = "worktree",
): WorktreeRestoreWarning => ({ code: "stale-restore-retained", path, kind });
const retainedWarnings = (warnings: readonly WorktreeRestoreWarning[]) =>
	warnings.filter((candidate) => candidate.code === "stale-restore-retained");
const siblingStaging = (target: string, id: string) =>
	join(dirname(target), `.${basename(target)}.atomic-restore-${id}`);

function uuid(): string {
	const hex = createHash("sha256").update(String(Math.random())).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The restores a run under `faults` started: warnings through `onWarning`, and the outcome. */
async function restoreInto(
	snapshot: WorktreeSnapshot,
	blobs: MemorySnapshotBlobStore,
	storeDir: string,
	into: string,
	signal?: AbortSignal,
) {
	const warnings: WorktreeRestoreWarning[] = [];
	const outcome = await restoreWorktree(snapshot, {
		blobs,
		storeDir,
		into,
		signal,
		onWarning: (w) => warnings.push(w),
	}).then(
		(restored) => ({ restored, error: undefined }),
		(error: unknown) => ({ restored: undefined, error }),
	);
	return { warnings, ...outcome };
}

/** Aborts `controller` with `reason` as the restore's `read-tree --reset -u` starts, after staging exists. */
function failAtCheckout(controller: AbortController, reason: unknown, beforeAbort?: () => void): void {
	faults.spawnHook = (args) => {
		if (is(args, "read-tree", "--reset", "-u")) {
			beforeAbort?.();
			queueMicrotask(() => controller.abort(reason));
		}
		return undefined;
	};
}

/** The staging path of the `git worktree add` a restore starts. */
function stagingOf(args: readonly string[]): string {
	const rest = command(args);
	return rest[rest.length - 2]!;
}

describe("a restore whose process lost its lock", () => {
	test("fails with the staging lock lost, cleans up its staging worktree and leaves no record", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const into = sandbox.path("final");
		const lost = Object.assign(new Error("lock lost"), { code: "ECOMPROMISED" });
		let staging = "";
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
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
		assert.equal((await registered(storeOf(storeDir, snapshot))).includes(staging), false);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
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
});

describe("where a restore stages its worktree", () => {
	test("by default under the host's worktrees directory, and next to the chosen directory otherwise", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const adds: string[] = [];
		faults.spawnHook = (args) => {
			if (is(args, "worktree", "add")) adds.push(stagingOf(args));
			return undefined;
		};
		const slug = uuid();
		const id = uuid();
		faults.uuids.push(slug, id);

		const first = await restoreWorktree(snapshot, { blobs, storeDir });
		const into = sandbox.path("chosen");
		const otherId = uuid();
		faults.uuids.push(otherId);
		await restoreWorktree(snapshot, { blobs, storeDir, into });

		assert.deepEqual(adds, [join(storeDir, "worktrees", `.staging-${id}`), siblingStaging(into, otherId)]);
		assert.equal(dirname(first.path), join(storeDir, "worktrees"));
		assert.equal(basename(first.path).endsWith(slug.slice(0, 8)), true);
	});
});

describe("publishing the verified worktree", () => {
	/** A restore whose store is warm, plus a worktree already registered in it that a hook can lock. */
	async function warmHost() {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const warm = await restoreWorktree(snapshot, { blobs, storeDir, into: sandbox.path("warm") });
		faults.spawns.length = 0;
		return { snapshot, blobs, storeDir, store: storeOf(storeDir, snapshot), warm: warm.path };
	}

	function raceInto(into: string): void {
		mkdirSync(into);
		writeFileSync(join(into, "keep.txt"), "user data\n");
	}

	test("a directory that appears after the last check is refused: Git's nested move is undone and the user's files are untouched", async () => {
		const { snapshot, blobs, storeDir, store, warm } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const staging = siblingStaging(into, id);
		faults.spawnHook = (args) => {
			if (is(args, "worktree", "move")) {
				raceInto(into);
				// A worktree locked with a reason that spells the target's path must not make it look registered.
				execFileSync("git", ["--git-dir", store, "worktree", "lock", "--reason", `xx${into}`, warm], {
					env: { ...process.env, ...sandbox.executable.env },
				});
			}
			return undefined;
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(isWorkspaceRestoreError(error), String(error));
		assert.equal(error.code, "unsafe-target");
		assert.equal(error.reason, "not-empty");
		assert.equal(error.target, into);
		assert.equal(error.snapshotId, snapshot.id);
		assert.equal(error.cleanupCause, undefined);
		assert.deepEqual(readdirSync(into), ["keep.txt"]);
		assert.equal(readFileSync(join(into, "keep.txt"), "utf8"), "user data\n");
		const listed = await registered(store);
		assert.equal(listed.includes(join(into, basename(staging))), false);
		assert.equal(listed.includes(staging), false);
		assert.deepEqual(retainedWarnings(warnings), []);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
	});

	test("when the nested worktree cannot be removed, the refusal carries that failure and names the leftover", async () => {
		const { snapshot, blobs, storeDir } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const nested = join(into, basename(siblingStaging(into, id)));
		faults.spawnHook = (args) => {
			if (is(args, "worktree", "move")) raceInto(into);
			if (is(args, "worktree", "remove", "--force", "--force", nested)) return { command: "false", args: [] };
			return undefined;
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(isWorkspaceRestoreError(error), String(error));
		assert.equal(error.code, "unsafe-target");
		assert.ok(isWorkspaceGitError(error.cleanupCause), String(error.cleanupCause));
		assert.equal(error.cleanupCause.exitCode, 1);
		assert.deepEqual(retainedWarnings(warnings), [warning(nested)]);
		assert.equal(readFileSync(join(into, "keep.txt"), "utf8"), "user data\n");
	});

	test("when Git leaves the worktree where it was, nothing nested is removed and nothing is reported", async () => {
		const { snapshot, blobs, storeDir } = await warmHost();
		const into = sandbox.path("final");
		faults.spawnHook = (args) => {
			if (is(args, "worktree", "move")) {
				raceInto(into);
				return { command: "true", args: [] };
			}
			return undefined;
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(isWorkspaceRestoreError(error), String(error));
		assert.equal(error.code, "unsafe-target");
		assert.equal(error.cleanupCause, undefined);
		assert.deepEqual(retainedWarnings(warnings), []);
		assert.deepEqual(readdirSync(into), ["keep.txt"]);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
	});

	test("a directory that appears before the move is refused before Git is asked to move anything", async () => {
		const { snapshot, blobs, storeDir } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const staging = siblingStaging(into, id);
		faults.spawnHook = (args, cwd) => {
			if (is(args, "write-tree") && cwd === staging) raceInto(into);
			return undefined;
		};

		const { error } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(isWorkspaceRestoreError(error), String(error));
		assert.equal(error.code, "unsafe-target");
		assert.equal(error.reason, "not-empty");
		assert.equal(error.target, into);
		assert.equal(error.snapshotId, snapshot.id);
		assert.equal(
			faults.spawns.some((spawned) => is(spawned.args, "worktree", "move")),
			false,
		);
		assert.deepEqual(readdirSync(into), ["keep.txt"]);
		assert.equal(existsSync(staging), false);
	});

	test("a destination that cannot be resolved after the move fails the restore as an unreadable path", async () => {
		const { snapshot, blobs, storeDir } = await warmHost();
		const into = sandbox.path("final");
		faults.realpath = (path) => {
			if (path === into) {
				throw Object.assign(new Error(`EIO: i/o error, realpath '${path}'`), {
					code: "EIO",
					syscall: "realpath",
					path,
				});
			}
		};

		const { error } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(isWorkspaceSnapshotError(error), String(error));
		assert.equal(error.code, "unreadable-path");
		assert.equal(error.subject, into);
		assert.equal((error.cause as NodeJS.ErrnoException).code, "EIO");
	});
});

describe("cleaning up after a failed restore", () => {
	/** A failed restore whose staging worktree `tamper` changes before the restore stops. */
	async function failedRestore(reason: unknown, tamper: (staging: string) => void, options: { into?: string } = {}) {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const into = options.into ?? sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const staging = siblingStaging(into, id);
		const controller = new AbortController();
		failAtCheckout(controller, reason, () => tamper(staging));
		const outcome = await restoreInto(snapshot, blobs, storeDir, into, controller.signal);
		return { ...outcome, snapshot, storeDir, store: storeOf(storeDir, snapshot), staging, into };
	}

	/** A directory a valid worktree link points back from, as a swapped-in symlink target would look. */
	function swapForSymlink(staging: string): string {
		const victim = sandbox.path("victim");
		mkdirSync(victim);
		writeFileSync(join(victim, "keep.txt"), "user data\n");
		writeFileSync(join(victim, ".git"), readFileSync(join(staging, ".git")));
		rmSync(staging, { recursive: true });
		symlinkSync(victim, staging, "dir");
		return victim;
	}

	test("a staging path swapped for a symlink is refused: the failure carries that refusal and the target is untouched", async () => {
		const reason = new Error("stop");
		let victim = "";
		const { error, warnings, staging } = await failedRestore(reason, (path) => {
			victim = swapForSymlink(path);
		});

		assert.equal(error, reason);
		const cleanup = (error as Error & { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceRestoreError(cleanup), String(cleanup));
		assert.equal(cleanup.code, "unsafe-target");
		assert.equal(cleanup.reason, "not-restored");
		assert.equal(cleanup.target, staging);
		assert.equal(cleanup.snapshotId, null);
		assert.deepEqual(retainedWarnings(warnings), [warning(staging)]);
		assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "user data\n");
		assert.equal(lstatSync(staging).isSymbolicLink(), true);
	});

	test("a staging path swapped for a dangling symlink is refused the same way, not as an unreadable path", async () => {
		const reason = new Error("stop");
		const { error, warnings, staging } = await failedRestore(reason, (path) => {
			rmSync(path, { recursive: true });
			symlinkSync(sandbox.path("nowhere"), path, "dir");
		});

		assert.equal(error, reason);
		const cleanup = (error as Error & { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceRestoreError(cleanup), String(cleanup));
		assert.equal(cleanup.code, "unsafe-target");
		assert.deepEqual(retainedWarnings(warnings), [warning(staging)]);
	});

	test("a failure that is not an Error is still thrown as it is, with the leftover reported", async () => {
		const { error, warnings, staging } = await failedRestore("stop", (path) => {
			swapForSymlink(path);
		});

		assert.equal(error, "stop");
		assert.deepEqual(retainedWarnings(warnings), [warning(staging)]);
	});

	test("a worktree Git refuses to remove is kept with its files, and the failure names the command and its exit code", async () => {
		const reason = new Error("stop");
		const { error, warnings, staging, store } = await failedRestore(reason, (path) => {
			rmSync(join(path, ".git"));
			writeFileSync(join(path, ".git"), "gitdir: /nonexistent\n");
			writeFileSync(join(path, "work.txt"), "unsaved work\n");
		});

		assert.equal(error, reason);
		const cleanup = (error as Error & { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceGitError(cleanup), String(cleanup));
		assert.equal(cleanup.operation, "worktree remove");
		assert.equal(cleanup.exitCode, 128);
		assert.equal(cleanup.detail, "could not remove the staging worktree");
		assert.equal(cleanup.cwd, dirname(store));
		assert.deepEqual(retainedWarnings(warnings), [warning(staging)]);
		assert.equal(readFileSync(join(staging, "work.txt"), "utf8"), "unsaved work\n");
	});

	test("a worktree that Git still lists after removal and pruning is reported as still registered", async () => {
		const reason = new Error("stop");
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host");
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const staging = siblingStaging(into, id);
		const controller = new AbortController();
		let failing = false;
		faults.spawnHook = (args) => {
			if (is(args, "read-tree", "--reset", "-u")) {
				failing = true;
				queueMicrotask(() => controller.abort(reason));
			}
			// Once the restore has failed, Git's removal and pruning do nothing, so the registration survives.
			if (failing && (is(args, "worktree", "remove") || is(args, "worktree", "prune"))) {
				return { command: "true", args: [] };
			}
			return undefined;
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into, controller.signal);

		assert.equal(error, reason);
		const cleanup = (error as Error & { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceGitError(cleanup), String(cleanup));
		assert.equal(cleanup.operation, "worktree prune");
		assert.equal(cleanup.exitCode, null);
		assert.equal(cleanup.detail, "the staging worktree is still registered");
		assert.equal(cleanup.cwd, join(storeDir, "repositories"));
		assert.deepEqual(retainedWarnings(warnings), [warning(staging)]);
	});

	test("a staging path that cannot be inspected is reported as an unreadable path, naming the filesystem error", async () => {
		const reason = new Error("stop");
		let armed: string | undefined;
		faults.lstat = (path) => {
			if (path === armed) {
				throw Object.assign(new Error(`EIO: i/o error, lstat '${path}'`), { code: "EIO", syscall: "lstat", path });
			}
		};
		const { error, warnings, staging } = await failedRestore(reason, (path) => {
			armed = path;
		});

		assert.equal(error, reason);
		const cleanup = (error as Error & { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceSnapshotError(cleanup), String(cleanup));
		assert.equal(cleanup.code, "unreadable-path");
		assert.equal(cleanup.subject, staging);
		assert.equal((cleanup.cause as NodeJS.ErrnoException).code, "EIO");
		assert.deepEqual(retainedWarnings(warnings), [warning(staging)]);
	});

	test("a staging directory whose real path cannot be resolved is reported as an unreadable path", async () => {
		const reason = new Error("stop");
		let armed: string | undefined;
		faults.realpath = (path) => {
			if (path === armed) {
				throw Object.assign(new Error(`EIO: i/o error, realpath '${path}'`), {
					code: "EIO",
					syscall: "realpath",
					path,
				});
			}
		};
		const { error, staging } = await failedRestore(reason, (path) => {
			armed = path;
		});

		assert.equal(error, reason);
		const cleanup = (error as Error & { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceSnapshotError(cleanup), String(cleanup));
		assert.equal(cleanup.code, "unreadable-path");
		assert.equal(cleanup.subject, staging);
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
