import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
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
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { startHostProcessesThroughChildProcess } from "../helpers/host-spawn.js";

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

startHostProcessesThroughChildProcess();

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

/** Git's registered worktree paths, spelled as `resolve` spells them: Git for Windows lists them with `/`. */
async function registered(store: string): Promise<string[]> {
	const listing = await sandbox.git(sandbox.root, "--git-dir", store, "worktree", "list", "--porcelain");
	return listing
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => resolve(line.slice("worktree ".length)));
}

/** Whether `listed` names `path`, ignoring case on Windows as its file system does. */
function lists(listed: readonly string[], path: string): boolean {
	const fold = (entry: string) => (process.platform === "win32" ? resolve(entry).toLowerCase() : resolve(entry));
	return listed.some((entry) => fold(entry) === fold(path));
}

const warning = (
	path: string,
	kind: "worktree" | "record" | "records-directory" = "worktree",
): WorktreeRestoreWarning => ({ code: "stale-restore-retained", path, kind });
const retainedWarnings = (warnings: readonly WorktreeRestoreWarning[]) =>
	warnings.filter((candidate) => candidate.code === "stale-restore-retained");
/** The staging worktree beside `target` of the restore `id`: `.s-` and 12 hex digits of the id (#5139). */
const siblingStaging = (target: string, id: string) =>
	join(dirname(target), `.${basename(target)}.s-${id.replaceAll("-", "").slice(0, 12)}`);
/** Where a restore sets the worktree it cleans up aside: its staging path with `.d-` in place of `.s-` (#4748). */
const asideOf = (staging: string) => staging.replace(/\.s-([0-9a-f]{12})$/, ".d-$1");

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
	async function leftBehind() {
		const { snapshot, blobs } = await dirtyClone();
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

	test("a file the user put into the restore's own staging worktree is kept, moved aside with the worktree (#4748)", async () => {
		const { snapshot, blobs, storeDir, staging } = await leftBehind();
		writeFileSync(join(staging, "keep.txt"), "user data\n");

		const next = await restoreInto(snapshot, blobs, storeDir, sandbox.path("other"));

		assert.equal(next.error, undefined);
		assert.equal(readFileSync(join(asideOf(staging), "keep.txt"), "utf8"), "user data\n");
		assert.deepEqual(retainedWarnings(next.warnings), [warning(asideOf(staging))]);
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

		assert.deepEqual(adds, [
			join(storeDir, "worktrees", `.s-${id.replaceAll("-", "").slice(0, 12)}`),
			siblingStaging(into, otherId),
		]);
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
		assert.equal(lists(listed, join(into, basename(staging))), false);
		assert.equal(lists(listed, staging), false);
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

	/** A restore stopped as the first Git command after its move starts, when the move has put its worktree in place. */
	async function stoppedAfterMove(collision: boolean): Promise<void> {
		const { snapshot, blobs, storeDir, store, warm } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const namesake = sandbox.path("namesake", basename(siblingStaging(into, id)));
		if (collision) {
			const head = await sandbox.git(warm, "rev-parse", "HEAD");
			await sandbox.git(
				sandbox.root,
				"--git-dir",
				store,
				"worktree",
				"add",
				"--detach",
				"-q",
				namesake,
				head.trim(),
			);
		}
		const namesakeAdmin = collision ? basename(readFileSync(join(namesake, ".git"), "utf8").trim()) : undefined;
		const admins = new Set(readdirSync(join(store, "worktrees")));
		const reason = new Error("stop after the move");
		const controller = new AbortController();
		let moved = false;
		let admin = "";
		faults.spawnHook = (args) => {
			// The first Git command after the move, while the moved worktree is already at the target.
			if (moved && !controller.signal.aborted) queueMicrotask(() => controller.abort(reason));
			if (is(args, "worktree", "move") && !moved) {
				moved = true;
				admin = basename(readFileSync(join(siblingStaging(into, id), ".git"), "utf8").trim());
			}
			return undefined;
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into, controller.signal);

		assert.equal(error, reason);
		assert.equal(moved, true);
		if (namesakeAdmin !== undefined)
			assert.ok(
				admin !== namesakeAdmin && admin.startsWith(namesakeAdmin),
				`Git numbered ${admin} after ${namesakeAdmin}`,
			);
		assert.equal(existsSync(into), false, "the moved worktree is removed from the target");
		const listed = await registered(store);
		assert.equal(lists(listed, into), false);
		assert.deepEqual(new Set(readdirSync(join(store, "worktrees"))), admins, "no admin entry is left behind");
		if (collision) {
			assert.equal(lists(listed, namesake), true, "the worktree of the same name is kept");
			assert.equal(existsSync(join(namesake, ".git")), true);
		}
		assert.deepEqual(retainedWarnings(warnings), []);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
	}

	test("a restore stopped once Git has moved its worktree into place removes that worktree and leaves no record", () =>
		stoppedAfterMove(false));

	test("the same holds when Git numbered the moved worktree's admin name after another worktree of that name", () =>
		stoppedAfterMove(true));

	test("a restore stopped once it holds the store's lock to publish never asks Git to move its worktree", async () => {
		const { snapshot, blobs, storeDir, store } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const staging = siblingStaging(into, id);
		const reason = new Error("stop before the move");
		const controller = new AbortController();
		let verified = false;
		faults.spawnHook = (args, cwd) => {
			if (is(args, "write-tree") && cwd === staging) verified = true;
			return undefined;
		};
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
			if (verified && file === store && !controller.signal.aborted) controller.abort(reason);
			return release;
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into, controller.signal);

		assert.equal(error, reason);
		assert.equal(
			faults.spawns.some((spawned) => is(spawned.args, "worktree", "move")),
			false,
		);
		assert.equal(existsSync(into), false);
		assert.equal(existsSync(staging), false);
		assert.deepEqual(retainedWarnings(warnings), []);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
	});

	test("when the moved worktree's files cannot be deleted after the stop, the warning names where they are kept", async () => {
		const { snapshot, blobs, storeDir } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const staging = siblingStaging(into, id);
		const reason = new Error("stop after the move");
		const controller = new AbortController();
		let moved = false;
		faults.spawnHook = (args) => {
			if (moved && !controller.signal.aborted) queueMicrotask(() => controller.abort(reason));
			if (is(args, "worktree", "move")) moved = true;
			return undefined;
		};
		faults.rm = (path) => {
			if (path === join(asideOf(staging), "dirty.txt")) {
				throw Object.assign(new Error(`EBUSY: resource busy, rm '${path}'`), {
					code: "EBUSY",
					syscall: "rm",
					path,
				});
			}
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into, controller.signal);

		assert.equal(error, reason);
		assert.equal((error as { cleanupCause?: { code?: string } }).cleanupCause?.code, "unwritable-path");
		assert.equal(existsSync(into), false);
		assert.equal(readFileSync(join(asideOf(staging), "dirty.txt"), "utf8"), "recorded\n");
		assert.deepEqual(retainedWarnings(warnings), [warning(asideOf(staging))]);
	});

	test("a restore stopped after the move deletes its worktree's files only once it no longer holds the store's lock (#4748)", async () => {
		const { snapshot, blobs, storeDir, store } = await warmHost();
		const into = sandbox.path("final");
		const reason = new Error("stop after the move");
		const controller = new AbortController();
		let moved = false;
		let storeLocked = false;
		const deletedUnderLock: string[] = [];
		/** Whether a deletion of `path` would delete the worktree's files: the file itself, or a directory holding it. */
		const holdsFiles = (path: string) => basename(path) === "dirty.txt" || existsSync(join(path, "dirty.txt"));
		faults.spawnHook = (args) => {
			if (moved && !controller.signal.aborted) queueMicrotask(() => controller.abort(reason));
			if (is(args, "worktree", "move")) moved = true;
			const removed = command(args).at(-1)!;
			if (storeLocked && is(args, "worktree", "remove") && holdsFiles(removed)) deletedUnderLock.push(removed);
			return undefined;
		};
		faults.lock = async (file, options, real) => {
			const release = await real(file, options);
			if (file !== store) return release;
			storeLocked = true;
			return async () => {
				storeLocked = false;
				await release();
			};
		};
		faults.rm = (path) => {
			if (storeLocked && holdsFiles(path)) deletedUnderLock.push(path);
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into, controller.signal);

		assert.equal(error, reason);
		assert.equal(existsSync(into), false);
		assert.deepEqual(deletedUnderLock, []);
		assert.equal(lists(await registered(store), into), false);
		assert.deepEqual(retainedWarnings(warnings), []);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
	});

	for (const failing of ["the listing of the store's worktrees", "the resolution of the target"] as const) {
		test(`a restore whose check after the move fails at ${failing} removes the worktree Git moved (#4748)`, async () => {
			const { snapshot, blobs, storeDir, store } = await warmHost();
			const into = sandbox.path("final");
			let moved = false;
			let listed = false;
			faults.spawnHook = (args) => {
				if (is(args, "worktree", "move")) moved = true;
				if (
					failing === "the listing of the store's worktrees" &&
					moved &&
					!listed &&
					is(args, "worktree", "list")
				) {
					listed = true;
					return { command: "false", args: [] };
				}
				return undefined;
			};
			faults.realpath = (path) => {
				if (failing === "the resolution of the target" && moved && path === into) {
					throw Object.assign(new Error(`EIO: i/o error, realpath '${path}'`), {
						code: "EIO",
						syscall: "realpath",
						path,
					});
				}
			};

			const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

			assert.ok(error instanceof Error, String(error));
			assert.equal((error as { cleanupCause?: unknown }).cleanupCause, undefined);
			assert.equal(existsSync(into), false, "the worktree Git moved is removed from the target");
			faults.spawnHook = undefined;
			assert.equal(lists(await registered(store), into), false);
			assert.deepEqual(retainedWarnings(warnings), []);
			assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
		});
	}

	test("a worktree of the same store at the target that reuses the moved worktree's admin name is kept with its files (#4748)", async () => {
		const { snapshot, blobs, storeDir, store, warm } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const staging = siblingStaging(into, id);
		const env = { ...process.env, ...sandbox.executable.env };
		let moved = false;
		faults.spawnHook = (args) => {
			if (!moved && is(args, "worktree", "move")) moved = true;
			else if (moved && is(args, "worktree", "list")) {
				moved = false;
				// The moved worktree is gone and pruned; another, added under the same name, now stands at the target.
				rmSync(into, { recursive: true, force: true });
				execFileSync("git", ["--git-dir", store, "worktree", "prune"], { env });
				const head = execFileSync("git", ["-C", warm, "rev-parse", "HEAD"], { env }).toString().trim();
				const namesake = sandbox.path("elsewhere", basename(staging));
				execFileSync("git", ["--git-dir", store, "worktree", "add", "-q", "--detach", namesake, head], { env });
				execFileSync("git", ["--git-dir", store, "worktree", "move", namesake, into], { env });
				writeFileSync(join(into, "keep.txt"), "user data\n");
				return { command: "false", args: [] };
			}
			return undefined;
		};

		const { error } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(error instanceof Error, String(error));
		assert.equal(readFileSync(join(into, "keep.txt"), "utf8"), "user data\n");
		assert.equal(lists(await registered(store), into), true, "the other worktree is still registered");
	});

	test("a worktree of the same store that appears at the target as Git moves is refused and kept with its files", async () => {
		const { snapshot, blobs, storeDir, store, warm } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const nested = join(into, basename(siblingStaging(into, id)));
		faults.spawnHook = (args) => {
			if (is(args, "worktree", "move") && !command(args).includes(warm)) {
				execFileSync("git", ["--git-dir", store, "worktree", "move", warm, into], {
					env: { ...process.env, ...sandbox.executable.env },
				});
				writeFileSync(join(into, "keep.txt"), "user data\n");
			}
			return undefined;
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(isWorkspaceRestoreError(error), String(error));
		assert.equal(error.code, "unsafe-target");
		assert.equal(error.reason, "not-empty");
		assert.equal(readFileSync(join(into, "keep.txt"), "utf8"), "user data\n");
		assert.equal(readFileSync(join(into, "dirty.txt"), "utf8"), "recorded\n");
		assert.equal(existsSync(nested), false);
		const listed = await registered(store);
		assert.equal(lists(listed, into), true, "the other worktree is still registered");
		assert.equal(lists(listed, nested), false);
		assert.deepEqual(retainedWarnings(warnings), []);
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

	test("a staging worktree whose .git no longer names an administrative directory of the store is moved aside and kept with its files (#4748)", async () => {
		const reason = new Error("stop");
		const { error, warnings, staging } = await failedRestore(reason, (path) => {
			rmSync(join(path, ".git"));
			writeFileSync(join(path, ".git"), "gitdir: /nonexistent\n");
		});

		assert.equal(error, reason);
		const cleanup = (error as Error & { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceRestoreError(cleanup), String(cleanup));
		assert.equal(cleanup.code, "unsafe-target");
		assert.equal(cleanup.reason, "not-restored");
		assert.equal(existsSync(staging), false);
		assert.equal(readFileSync(join(asideOf(staging), ".git"), "utf8"), "gitdir: /nonexistent\n");
		assert.deepEqual(retainedWarnings(warnings), [warning(asideOf(staging))]);
	});

	test("a file someone writes into the restore's worktree is kept with it, aside, and the warning names where (#4748)", async () => {
		const reason = new Error("stop");
		const { error, warnings, staging } = await failedRestore(reason, (path) => {
			writeFileSync(join(path, "work.txt"), "unsaved work\n");
		});

		assert.equal(error, reason);
		const cleanup = (error as Error & { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceRestoreError(cleanup), String(cleanup));
		assert.equal(cleanup.target, asideOf(staging));
		assert.deepEqual(retainedWarnings(warnings), [warning(asideOf(staging))]);
		assert.equal(readFileSync(join(asideOf(staging), "work.txt"), "utf8"), "unsaved work\n");
	});

	test("a file changed after the worktree was set aside is kept, and so is the directory holding it (#4748)", async () => {
		const reason = new Error("stop");
		let changed = false;
		const { error, warnings, staging } = await failedRestore(reason, (path) => {
			faults.lock = async (file, options, real) => {
				const release = await real(file, options);
				return async () => {
					await release();
					const aside = asideOf(path);
					if (!changed && existsSync(join(aside, ".git"))) {
						changed = true;
						writeFileSync(join(aside, ".git"), "gitdir: changed after the check\n");
					}
				};
			};
		});

		assert.equal(error, reason);
		assert.equal(changed, true);
		assert.equal(readFileSync(join(asideOf(staging), ".git"), "utf8"), "gitdir: changed after the check\n");
		assert.deepEqual(retainedWarnings(warnings), [warning(asideOf(staging))]);
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
