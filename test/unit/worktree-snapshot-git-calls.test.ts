import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const recorded = vi.hoisted(() => ({
	spawns: [] as { args: readonly string[]; cwd: string }[],
	failRemovalOf: undefined as string | undefined,
	/** Fail removing a restore's scratch directory, the one holding the empty attributes file it materializes with. */
	failScratchRemoval: false,
	/** Fail writing a file with this base name, as a full disk would. */
	failWriteOf: undefined as string | undefined,
	removals: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: readonly string[], options: { cwd?: string }) => {
			recorded.spawns.push({ args, cwd: String(options?.cwd) });
			return (actual.spawn as (...parameters: unknown[]) => unknown)(command, args, options);
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (path: string, options?: object) => {
			recorded.removals.push(String(path));
			if (recorded.failRemovalOf !== undefined && String(path).includes(recorded.failRemovalOf)) {
				throw Object.assign(new Error(`cannot remove ${path}`), { code: "EBUSY", syscall: "rm", path });
			}
			if (recorded.failScratchRemoval && existsSync(join(String(path), "empty-attributes"))) {
				throw Object.assign(new Error(`cannot remove scratch ${path}`), { code: "EBUSY", syscall: "rm", path });
			}
			return actual.rm(path, options);
		},
		writeFile: async (path: string, ...rest: unknown[]) => {
			if (recorded.failWriteOf !== undefined && basename(String(path)) === recorded.failWriteOf) {
				throw Object.assign(new Error(`ENOSPC: no space left on device, open '${path}'`), {
					code: "ENOSPC",
					syscall: "open",
					path,
				});
			}
			return (actual.writeFile as (...parameters: unknown[]) => Promise<void>)(path, ...rest);
		},
	};
});

import { withScratchDirectory } from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import {
	captureWorktreeSnapshot,
	isWorkspaceRestoreError,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	restoreWorktree,
	restoreWorktreeSnapshot,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
	recorded.failRemovalOf = undefined;
	recorded.failScratchRemoval = false;
	recorded.failWriteOf = undefined;
	recorded.removals.length = 0;
});
afterEach(() => sandbox.dispose());

/** The Git arguments of each recorded invocation since the last reset, past the fixed `-c key=value` pairs. */
function invocations(): string[][] {
	return recorded.spawns.map(({ args }) => {
		const rest: string[] = [];
		for (let index = 0; index < args.length; index++) {
			if (rest.length === 0 && args[index] === "-c") index++;
			else rest.push(args[index]!);
		}
		return rest;
	});
}
/** Invocations of `name`: a subcommand, or `"worktree prune"` for a subcommand with its first argument. */
const count = (name: string) =>
	invocations().filter((rest) => {
		const [first, second] = rest.filter((arg) => !arg.startsWith("-"));
		return name.includes(" ") ? `${first} ${second}` === name : first === name;
	}).length;
/** Invocations of `update-index` that stage files, not the refresh every capture runs on its private index. */
const admissions = () => invocations().filter((rest) => rest[0] === "update-index" && rest.includes("--add")).length;
const reset = () => {
	recorded.spawns.length = 0;
};

function captured(result: WorktreeSnapshotCapture): WorktreeSnapshot {
	assert.equal(result.status, "captured");
	return (result as Extract<WorktreeSnapshotCapture, { status: "captured" }>).snapshot;
}

describe("capture operation counts", () => {
	test("a tree with nothing to admit never stages files with update-index", async () => {
		const { clone } = await sandbox.remoteWithClone();
		reset();
		captured(await captureWorktreeSnapshot(clone));
		assert.equal(admissions(), 0);
		sandbox.write(join(clone, "x.txt"), "x\n");
		reset();
		captured(await captureWorktreeSnapshot(clone));
		assert.equal(admissions(), 1);
	});

	test("a capture that leaves files out resets nothing: its index already holds HEAD's content (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, ".env.local"), "TOKEN=1\n");
		reset();
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(result.omitted, [{ reason: "denied", path: ".env.local" }]);
		assert.equal(count("reset"), 0);
		assert.equal(admissions(), 0);
	});

	test("a new capture with unchanged unpushed history reuses the bundle without creating another (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		await sandbox.commitAll(clone, "unpushed");
		const blobs = new MemorySnapshotBlobStore();
		reset();
		const first = captured(await captureWorktreeSnapshot(clone, { blobs }));
		assert.equal(count("bundle"), 1);
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		reset();
		const second = captured(await captureWorktreeSnapshot(clone, { blobs, previous: first }));
		assert.equal(count("bundle"), 0);
		assert.deepEqual(second.bundle, first.bundle);
		assert.equal(count("rev-list"), 1);
	});

	test("the bundle is rebuilt when the unpushed commits, their order or HEAD differ from the previous snapshot", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "one.txt"), "1\n");
		const one = await sandbox.commitAll(clone, "one");
		sandbox.write(join(clone, "two.txt"), "2\n");
		const two = await sandbox.commitAll(clone, "two");
		const first = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(first.bundle?.commits, [two, one]);
		let edits = 0;
		const bundleCount = async (previous: WorktreeSnapshot) => {
			sandbox.write(join(clone, `edit-${edits++}.txt`), "a new tree each time\n");
			reset();
			await captureWorktreeSnapshot(clone, { previous });
			return count("bundle");
		};
		const bundle = first.bundle!;
		assert.equal(await bundleCount({ ...first, bundle: { ...bundle, commits: [two, one] } }), 0);
		assert.equal(await bundleCount({ ...first, head: "f".repeat(40) }), 1);
		assert.equal(await bundleCount({ ...first, bundle: { ...bundle, commits: [two] } }), 1);
		assert.equal(await bundleCount({ ...first, bundle: { ...bundle, commits: [two, one, "e".repeat(40)] } }), 1);
		assert.equal(await bundleCount({ ...first, bundle: { ...bundle, commits: [two, "e".repeat(40)] } }), 1);
		assert.equal(await bundleCount({ ...first, bundle: { ...bundle, commits: [one, two] } }), 1);
		assert.equal(await bundleCount({ ...first, bundle: null }), 1);
	});

	test("denied unpushed paths are listed in path order, across a merge, with the commits that carry them", async () => {
		const { clone } = await sandbox.remoteWithClone();
		await sandbox.git(clone, "checkout", "-q", "-b", "side");
		sandbox.write(join(clone, "a.pem"), "A\n");
		const older = await sandbox.commitAll(clone, "older");
		sandbox.write(join(clone, "z.pem"), "Z\n");
		const newer = await sandbox.commitAll(clone, "newer");
		await sandbox.git(clone, "checkout", "-q", "main");
		sandbox.write(join(clone, "main.txt"), "m\n");
		await sandbox.commitAll(clone, "diverge");
		await sandbox.git(clone, "merge", "-q", "--no-ff", "-m", "merge side", "side");
		const merge = await sandbox.git(clone, "rev-parse", "HEAD");
		const result = captured(await captureWorktreeSnapshot(clone));
		assert.equal(result.bundle, null);
		const [omission] = result.omitted;
		assert.ok(omission?.reason === "unpushed-history-denied");
		assert.deepEqual(omission.paths, ["a.pem", "z.pem"]);
		assert.deepEqual(omission.commits, [merge, newer, older]);
	});
});

describe("restore operation counts", () => {
	test("restoring a warm tree again fetches nothing and applies nothing", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = captured(await captureWorktreeSnapshot(clone, { blobs }));
		const storeDir = sandbox.path("host");
		reset();
		await restoreWorktreeSnapshot(snapshot, { blobs, storeDir });
		assert.equal(count("fetch"), 1);
		assert.equal(count("apply"), 1);
		assert.equal(count("worktree add"), 1);
		assert.equal(count("worktree move"), 1);
		reset();
		await restoreWorktreeSnapshot(snapshot, { blobs, storeDir });
		assert.equal(count("fetch"), 0);
		assert.equal(count("apply"), 0);
		assert.equal(count("bundle"), 0);
		assert.equal(count("worktree add"), 1);
		assert.equal(count("worktree move"), 1);
		assert.equal(count("cat-file"), 2, "the head and the tree are each checked once");
	});

	test("concurrent restores of one cold snapshot share one fetch and one reconstruction", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = captured(await captureWorktreeSnapshot(clone, { blobs }));
		reset();
		const paths = await Promise.all(
			[0, 1, 2, 3].map(() => restoreWorktreeSnapshot(snapshot, { blobs, storeDir: sandbox.path("host") })),
		);
		assert.equal(new Set(paths).size, 4);
		assert.equal(count("fetch"), 1);
		assert.equal(count("apply"), 1);
		assert.equal(count("worktree add"), 4);
		assert.equal(count("worktree move"), 4);
	});

	test("each distinct remote list gets its own shared store, named from a hash of the list", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = captured(await captureWorktreeSnapshot(clone, { blobs }));
		const storeDir = sandbox.path("host");
		const unreachable = [["ab"], ["a", "b"]];
		for (const remotes of unreachable) {
			await assert.rejects(
				restoreWorktreeSnapshot({ ...snapshot, remotes }, { blobs, storeDir }),
				(error: unknown) => isWorkspaceRestoreError(error) && error.code === "commits-unavailable",
			);
		}
		const expected = unreachable.map(
			(remotes) => `${createHash("sha256").update(remotes.join("\n")).digest("hex").slice(0, 24)}.git`,
		);
		assert.equal(new Set(expected).size, 2);
		assert.deepEqual(readdirSync(join(storeDir, "repositories")).sort(), [...expected].sort());
		const restored = await restoreWorktree(snapshot, { blobs, storeDir });
		const common = resolve(await sandbox.git(restored.path, "rev-parse", "--git-common-dir"));
		const hostStore = `${createHash("sha256").update(snapshot.remotes.join("\n")).digest("hex").slice(0, 24)}.git`;
		assert.equal(common, join(storeDir, "repositories", hostStore));
	});
});

describe("cleanup failures never replace the primary error", () => {
	test("a scratch directory that cannot be removed is attached to the action's failure as cleanupCause", async () => {
		const primary = new Error("primary failure");
		let scratch = "";
		recorded.failRemovalOf = "atomic-snapshot-";
		await assert.rejects(
			withScratchDirectory(async (directory) => {
				scratch = directory;
				throw primary;
			}),
			(error: unknown) => {
				assert.equal(error, primary);
				const cleanup = (error as { cleanupCause?: Error }).cleanupCause;
				assert.equal(cleanup?.message, `cannot remove ${scratch}`);
				return true;
			},
		);
		assert.ok(recorded.removals.includes(scratch));
		recorded.failRemovalOf = undefined;
		await withScratchDirectory(async () => {});
	});

	test("a scratch directory is removed, recursively and even when files remain in it, after success and failure", async () => {
		const seen: string[] = [];
		await withScratchDirectory(async (directory) => {
			seen.push(directory);
			writeFileSync(join(directory, "left-behind"), "x");
			mkdirSync(join(directory, "nested"));
			writeFileSync(join(directory, "nested", "deep"), "x");
		});
		await assert.rejects(
			withScratchDirectory(async (directory) => {
				seen.push(directory);
				writeFileSync(join(directory, "left-behind"), "x");
				throw new Error("action failed");
			}),
			/action failed/,
		);
		assert.equal(seen.length, 2);
		for (const directory of seen) assert.equal(existsSync(directory), false);
	});

	test("a staging worktree that cannot be removed after a failed restore is attached to the restore error", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitattributes": "*.txt filter=mangle\n" });
		sandbox.write(join(clone, "note.txt"), "alpha\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = captured(await captureWorktreeSnapshot(clone, { blobs }));
		writeFileSync(
			sandbox.globalConfig,
			`${(await import("node:fs")).readFileSync(sandbox.globalConfig, "utf8")}[filter "mangle"]\n\tsmudge = sed s/alpha/omega/\n`,
		);
		const into = sandbox.path("restored-target");
		recorded.failRemovalOf = "restored-target";
		await assert.rejects(
			restoreWorktreeSnapshot(snapshot, { blobs, into, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "tree-mismatch");
				const cleanup = error.cleanupCause;
				assert.ok(isWorkspaceRestoreError(cleanup));
				assert.equal(cleanup.code, "unwritable-path");
				assert.ok(
					cleanup.target?.startsWith(join(sandbox.root, ".restored-target.atomic-restore-")),
					cleanup.target,
				);
				assert.equal(cleanup.snapshotId, null);
				assert.equal((cleanup.cause as NodeJS.ErrnoException).code, "EBUSY");
				return true;
			},
		);
	});

	test("removing a restored worktree that resists removal is an unwritable path", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = captured(await captureWorktreeSnapshot(clone, { blobs }));
		const storeDir = sandbox.path("host");
		const into = sandbox.path("stuck-worktree");
		await restoreWorktreeSnapshot(snapshot, { blobs, into, storeDir });
		recorded.failRemovalOf = "stuck-worktree";
		await assert.rejects(removeRestoredWorktree(into, { storeDir }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "unwritable-path");
			assert.equal(error.target, into);
			assert.equal(error.snapshotId, null);
			assert.equal((error.cause as NodeJS.ErrnoException).code, "EBUSY");
			return true;
		});
	});

	test("the primary error survives when the worktree and the scratch directory both resist removal", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitattributes": "*.txt filter=mangle\n" });
		sandbox.write(join(clone, "note.txt"), "alpha\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = captured(await captureWorktreeSnapshot(clone, { blobs }));
		writeFileSync(
			sandbox.globalConfig,
			`${(await import("node:fs")).readFileSync(sandbox.globalConfig, "utf8")}[filter "mangle"]\n\tsmudge = sed s/alpha/omega/\n`,
		);
		const into = sandbox.path("restored-target");
		recorded.failRemovalOf = "restored-target";
		recorded.failScratchRemoval = true;
		await assert.rejects(
			restoreWorktreeSnapshot(snapshot, { blobs, into, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "tree-mismatch");
				assert.match((error as { cleanupCause?: Error }).cleanupCause?.message ?? "", /^cannot remove scratch /);
				return true;
			},
		);
		for (const path of recorded.removals) {
			if (existsSync(join(path, "empty-attributes"))) rmSync(path, { recursive: true, force: true });
		}
	});

	test("a pre-existing empty target is left in place, empty and unregistered, after a failed restore", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitattributes": "*.txt filter=mangle\n" });
		sandbox.write(join(clone, "note.txt"), "alpha\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = captured(await captureWorktreeSnapshot(clone, { blobs }));
		writeFileSync(
			sandbox.globalConfig,
			`${(await import("node:fs")).readFileSync(sandbox.globalConfig, "utf8")}[filter "mangle"]\n\tsmudge = sed s/alpha/omega/\n`,
		);
		const into = sandbox.path("existing-empty");
		mkdirSync(into);
		const storeDir = sandbox.path("host");
		reset();
		await assert.rejects(
			restoreWorktreeSnapshot(snapshot, { blobs, into, storeDir }),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "tree-mismatch",
		);
		assert.deepEqual(readdirSync(into), []);
		assert.equal(count("worktree prune"), 1);
		const store = join(storeDir, "repositories", readdirSync(join(storeDir, "repositories"))[0]!);
		const listed = await sandbox.git(sandbox.root, "--git-dir", store, "worktree", "list", "--porcelain");
		assert.doesNotMatch(listed, /existing-empty/);
	});
});

describe("a full disk during a restore", () => {
	test("each scratch file the restore writes reports an unwritable path naming it and the snapshot", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		await sandbox.commitAll(clone, "unpushed");
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = captured(await captureWorktreeSnapshot(clone, { blobs }));
		assert.ok(snapshot.bundle);
		for (const file of ["history.bundle", "delta-0.patch", "empty-attributes"]) {
			recorded.failWriteOf = file;
			const into = sandbox.path(`restored-${file}`);
			await assert.rejects(
				restoreWorktreeSnapshot(snapshot, { blobs, into, storeDir: sandbox.path(`host-${file}`) }),
				(error: unknown) => {
					assert.ok(isWorkspaceRestoreError(error), `${file}: ${String(error)}`);
					assert.equal(error.code, "unwritable-path");
					assert.equal(basename(error.target ?? ""), file);
					assert.equal(error.snapshotId, snapshot.id);
					assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOSPC");
					return true;
				},
			);
			assert.equal(existsSync(into), false);
		}
	});
});
