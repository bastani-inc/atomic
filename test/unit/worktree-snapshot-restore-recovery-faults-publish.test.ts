import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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
	isWorkspaceSnapshotError,
	restoreWorktree,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";
import {
	asideOf,
	command,
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

	test("when the nested worktree's files cannot be deleted, the refusal carries that failure and names where they are kept", async () => {
		const { snapshot, blobs, storeDir } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const aside = asideOf(siblingStaging(into, id));
		faults.spawnHook = (args) => {
			if (is(args, "worktree", "move")) raceInto(into);
			return undefined;
		};
		faults.rm = (path) => {
			if (path === join(aside, "dirty.txt")) {
				throw Object.assign(new Error(`EBUSY: resource busy, rm '${path}'`), {
					code: "EBUSY",
					syscall: "rm",
					path,
				});
			}
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(isWorkspaceRestoreError(error), String(error));
		assert.equal(error.code, "unsafe-target");
		assert.equal((error.cleanupCause as { code?: string } | undefined)?.code, "unwritable-path");
		assert.deepEqual(retainedWarnings(warnings), [warning(aside)]);
		assert.equal(readFileSync(join(aside, "dirty.txt"), "utf8"), "recorded\n");
		assert.deepEqual(readdirSync(into), ["keep.txt"]);
	});

	test("a file written into the nested worktree before its cleanup is kept, with the worktree set aside (#4748)", async () => {
		const { snapshot, blobs, storeDir } = await warmHost();
		const into = sandbox.path("final");
		const id = uuid();
		faults.uuids.push(id);
		const nested = join(into, basename(siblingStaging(into, id)));
		let moved = false;
		faults.spawnHook = (args) => {
			if (is(args, "worktree", "move")) {
				moved = true;
				raceInto(into);
			} else if (moved && is(args, "worktree", "list")) {
				moved = false;
				// Git has moved the worktree inside the directory that appeared; the user writes into it right away.
				queueMicrotask(() => writeFileSync(join(nested, "user.txt"), "user data\n"));
			}
			return undefined;
		};

		const { error, warnings } = await restoreInto(snapshot, blobs, storeDir, into);

		assert.ok(isWorkspaceRestoreError(error), String(error));
		const aside = asideOf(siblingStaging(into, id));
		assert.equal(readFileSync(join(aside, "user.txt"), "utf8"), "user data\n");
		assert.deepEqual(retainedWarnings(warnings), [warning(aside)]);
		assert.deepEqual(readdirSync(into), ["keep.txt"]);
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
		let changed = "";
		const seen: string[] = [];
		const { error, warnings, staging } = await failedRestore(reason, (path) => {
			const link = join(asideOf(path), ".git");
			// Once the worktree is set aside, someone rewrites its .git file before the deletion reaches it.
			faults.lstat = (inspected) => {
				if (basename(inspected) === ".git") seen.push(inspected);
				// The restore may spell the temporary directory differently on Windows (a short name, a drive letter's case).
				if (
					changed !== "" ||
					basename(inspected) !== ".git" ||
					!/\.d-[0-9a-f]{12}$/.test(basename(dirname(inspected)))
				)
					return;
				// Rewritten in place: Windows refuses to recreate the hidden .git file Git made.
				const handle = openSync(inspected, "r+");
				try {
					const text = Buffer.from("gitdir: changed after the check\n");
					writeSync(handle, text, 0, text.length, 0);
					ftruncateSync(handle, text.length);
				} finally {
					closeSync(handle);
				}
				changed = link;
			};
		});

		assert.equal(error, reason);
		assert.notEqual(changed, "", `.git paths inspected: ${seen.join(", ")}; staging ${staging}`);
		assert.equal(readFileSync(changed, "utf8"), "gitdir: changed after the check\n");
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
