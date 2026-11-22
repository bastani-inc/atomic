import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

/**
 * Run once, right after a read of a user's index (`.git/index`) by the code under test: the next read of all of it
 * (`afterIndexRead`), or the `opening`-th opening of it from now, once that is closed (`afterIndexOpen`).
 */
const hooks = vi.hoisted(() => ({
	/** How many times the code under test read all of a user's index. */
	indexReads: 0,
	afterIndexRead: undefined as (() => void) | undefined,
	afterIndexOpen: undefined as { opening: number; readonly hook: () => void } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: async (...args: Parameters<typeof actual.readFile>) => {
			const result = await actual.readFile(...args);
			const path = String(args[0]);
			if (basename(path) === "index" && basename(dirname(path)) === ".git") hooks.indexReads++;
			if (hooks.afterIndexRead !== undefined && basename(path) === "index" && basename(dirname(path)) === ".git") {
				const hook = hooks.afterIndexRead;
				hooks.afterIndexRead = undefined;
				hook();
			}
			return result;
		},
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const path = String(args[0]);
			if (hooks.afterIndexOpen === undefined || basename(path) !== "index" || basename(dirname(path)) !== ".git")
				return handle;
			if (--hooks.afterIndexOpen.opening > 0) return handle;
			const { hook } = hooks.afterIndexOpen;
			hooks.afterIndexOpen = undefined;
			const close = handle.close.bind(handle);
			handle.close = async () => {
				await close();
				hook();
			};
			return handle;
		},
	};
});

import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { GitSandbox, startedGitProcesses } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	hooks.afterIndexRead = undefined;
	hooks.afterIndexOpen = undefined;
	sandbox.dispose();
});

function captured(result: WorktreeSnapshotCapture): Extract<WorktreeSnapshotCapture, { status: "captured" }> {
	assert.equal(result.status, "captured", JSON.stringify(result));
	return result as Extract<WorktreeSnapshotCapture, { status: "captured" }>;
}

async function treePaths(cwd: string, tree: string): Promise<string[]> {
	return (await sandbox.git(cwd, "ls-tree", "-r", "--name-only", tree)).split("\n").filter(Boolean);
}

/** The Git processes started with `command` as their command since `trace` was last emptied, which empties it again. */
function started(trace: string, command: string): number {
	let count = 0;
	try {
		for (const { argv = [] } of startedGitProcesses(trace)) {
			const words = argv.slice(1).filter((arg, index, all) => arg !== "-c" && all[index - 1] !== "-c");
			if (words[0] === command) count++;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	rmSync(trace, { force: true });
	return count;
}

/** A clone whose `.gitignore` ignores `*.log` files. */
async function cloneIgnoringLogs(): Promise<string> {
	const { clone } = await sandbox.remoteWithClone("repo", { ".gitignore": "*.log\n", "README.md": "hello\n" });
	return clone;
}

describe("files staged in your index despite an ignore rule", () => {
	test("are kept without reading all of the index again while its checksum stays the same", async () => {
		const clone = await cloneIgnoringLogs();
		sandbox.write(join(clone, "forced.log"), "forced\n");
		await sandbox.git(clone, "add", "-f", "forced.log");
		captured(await captureWorktreeSnapshot(clone));
		hooks.indexReads = 0;
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone));
		assert.ok((await treePaths(clone, second.snapshot.tree)).includes("forced.log"));
		assert.equal(hooks.indexReads, 0, "the index's last bytes, its checksum, were read, not all of it");
	});

	test("are listed again only once the index or HEAD changed", async () => {
		const clone = await cloneIgnoringLogs();
		const trace = sandbox.traceGitProcesses();
		captured(await captureWorktreeSnapshot(clone));
		assert.equal(started(trace, "diff-index"), 1);
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		captured(await captureWorktreeSnapshot(clone));
		assert.equal(started(trace, "diff-index"), 0, "the same index and HEAD are not listed again");

		sandbox.write(join(clone, "forced.log"), "forced\n");
		await sandbox.git(clone, "add", "-f", "forced.log");
		const staged = captured(await captureWorktreeSnapshot(clone));
		assert.equal(started(trace, "diff-index"), 1);
		assert.ok((await treePaths(clone, staged.snapshot.tree)).includes("forced.log"));
		const again = captured(await captureWorktreeSnapshot(clone));
		assert.equal(started(trace, "diff-index"), 0);
		assert.ok((await treePaths(clone, again.snapshot.tree)).includes("forced.log"));
	});

	test("are listed against the new HEAD after a soft reset that leaves the index as it was", async () => {
		const clone = await cloneIgnoringLogs();
		sandbox.write(join(clone, "forced.log"), "forced\n");
		await sandbox.git(clone, "add", "-f", "forced.log");
		await sandbox.git(clone, "commit", "-q", "-m", "commit an ignored file");
		const committed = captured(await captureWorktreeSnapshot(clone));
		assert.ok((await treePaths(clone, committed.snapshot.tree)).includes("forced.log"));

		// HEAD no longer has the file; the index still stages it, so it is staged as an addition to HEAD.
		const index = readFileSync(join(clone, ".git", "index"));
		await sandbox.git(clone, "reset", "-q", "--soft", "HEAD~1");
		assert.deepEqual(readFileSync(join(clone, ".git", "index")), index);
		const reset = captured(await captureWorktreeSnapshot(clone));
		assert.ok((await treePaths(clone, reset.snapshot.tree)).includes("forced.log"));
	});

	test("include a staged submodule as its ignore setting says, which can change while the index does not", async () => {
		const clone = await cloneIgnoringLogs();
		const { clone: sub } = await sandbox.remoteWithClone("sub", { "inner.txt": "inner\n" });
		writeFileSync(join(clone, ".gitignore"), "*.log\nbuild/\n");
		await sandbox.git(clone, "submodule", "add", "-q", "-f", sub, "build/sub");
		const index = readFileSync(join(clone, ".git", "index"));
		const listed = captured(await captureWorktreeSnapshot(clone));
		assert.ok((await treePaths(clone, listed.snapshot.tree)).includes("build/sub"));

		// `ignore = all` hides the submodule from Git's listing of the staged files; the index's bytes stay as they were.
		writeFileSync(join(clone, ".gitmodules"), `${readFileSync(join(clone, ".gitmodules"), "utf8")}\tignore = all\n`);
		assert.deepEqual(readFileSync(join(clone, ".git", "index")), index);
		const hidden = captured(await captureWorktreeSnapshot(clone));
		assert.ok(!(await treePaths(clone, hidden.snapshot.tree)).includes("build/sub"));
	});

	test("include a staged submodule again once its ignore setting no longer hides it", async () => {
		const clone = await cloneIgnoringLogs();
		const { clone: sub } = await sandbox.remoteWithClone("sub", { "inner.txt": "inner\n" });
		writeFileSync(join(clone, ".gitignore"), "*.log\nbuild/\n");
		await sandbox.git(clone, "submodule", "add", "-q", "-f", sub, "build/sub");
		await sandbox.git(clone, "config", "submodule.build/sub.ignore", "all");
		const hidden = captured(await captureWorktreeSnapshot(clone));
		assert.ok(!(await treePaths(clone, hidden.snapshot.tree)).includes("build/sub"));

		await sandbox.git(clone, "config", "--unset", "submodule.build/sub.ignore");
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const listed = captured(await captureWorktreeSnapshot(clone));
		assert.ok((await treePaths(clone, listed.snapshot.tree)).includes("build/sub"));
	});

	test("are kept for the index bytes they were listed from, not for a change made while they were listed", async () => {
		const clone = await cloneIgnoringLogs();
		sandbox.write(join(clone, "late.log"), "late\n");
		const indexPath = join(clone, ".git", "index");
		const before = readFileSync(indexPath);
		// The user stages the ignored file while the first capture runs: just after it read the index, if it does.
		const stageLate = () =>
			execFileSync("git", ["add", "-f", "late.log"], {
				cwd: clone,
				env: { ...process.env, ...sandbox.executable.env },
				stdio: "ignore",
			});
		hooks.afterIndexRead = stageLate;
		captured(await captureWorktreeSnapshot(clone));
		if (hooks.afterIndexRead !== undefined) {
			hooks.afterIndexRead = undefined;
			stageLate();
		}

		// The index is back to the bytes the first capture listed, which stage nothing.
		writeFileSync(indexPath, before);
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(await treePaths(clone, second.snapshot.tree), [".gitignore", "README.md", "edit.txt"]);
	});

	test("are kept for the index bytes they were listed from, not for the last bytes read before them", async () => {
		const clone = await cloneIgnoringLogs();
		sandbox.write(join(clone, "late.log"), "late\n");
		const indexPath = join(clone, ".git", "index");
		const before = readFileSync(indexPath);
		// The user stages the ignored file right after the first capture read the index's last bytes: its second
		// opening of the index, after the one that reads what the private index is seeded from.
		hooks.afterIndexOpen = {
			opening: 2,
			hook: () =>
				execFileSync("git", ["add", "-f", "late.log"], {
					cwd: clone,
					env: { ...process.env, ...sandbox.executable.env },
					stdio: "ignore",
				}),
		};
		const first = captured(await captureWorktreeSnapshot(clone));
		assert.equal(hooks.afterIndexOpen, undefined, "the index was opened");
		assert.ok((await treePaths(clone, first.snapshot.tree)).includes("late.log"));

		// The index is back to the bytes whose last bytes the first capture read, which stage nothing.
		writeFileSync(indexPath, before);
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(await treePaths(clone, second.snapshot.tree), [".gitignore", "README.md", "edit.txt"]);
	});

	test("are listed again when an index written without a checksum changes and keeps its size", async () => {
		const clone = await cloneIgnoringLogs();
		// Git writes zeros where the checksum of the index goes: its last bytes no longer change with its content.
		await sandbox.git(clone, "config", "index.skipHash", "true");
		sandbox.write(join(clone, "aaa.log"), "a\n");
		sandbox.write(join(clone, "bbb.log"), "b\n");
		await sandbox.git(clone, "add", "-f", "aaa.log");
		const indexPath = join(clone, ".git", "index");
		const size = statSync(indexPath).size;
		const first = captured(await captureWorktreeSnapshot(clone));
		assert.ok((await treePaths(clone, first.snapshot.tree)).includes("aaa.log"));

		await sandbox.git(clone, "rm", "-q", "--cached", "aaa.log");
		await sandbox.git(clone, "add", "-f", "bbb.log");
		assert.equal(statSync(indexPath).size, size, "the index keeps its size");
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone));
		const paths = await treePaths(clone, second.snapshot.tree);
		assert.ok(paths.includes("bbb.log") && !paths.includes("aaa.log"), paths.join(" "));
	});

	test("are kept for at most 16 indexes: the one used longest ago is listed again", async () => {
		const clone = await cloneIgnoringLogs();
		const trace = sandbox.traceGitProcesses();
		captured(await captureWorktreeSnapshot(clone));
		// Sixteen other checkouts of the repository, each with an index of its own.
		for (let worktree = 0; worktree < 16; worktree++) {
			const path = sandbox.path(`worktree-${worktree}`);
			await sandbox.git(clone, "worktree", "add", "-q", "--detach", path);
			captured(await captureWorktreeSnapshot(path));
		}
		started(trace, "diff-index");
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		captured(await captureWorktreeSnapshot(clone));
		assert.equal(started(trace, "diff-index"), 1, "the first checkout's index, used longest ago, is listed again");
	});
});

describe("the tree of the previous snapshot, where Git does not trust file modes", () => {
	async function cloneWithoutTrustedModes(): Promise<string> {
		const { clone } = await sandbox.remoteWithClone();
		await sandbox.git(clone, "config", "core.filemode", "false");
		return clone;
	}

	test("is known to exist once the capture read it to compare modes", async () => {
		const clone = await cloneWithoutTrustedModes();
		const first = captured(await captureWorktreeSnapshot(clone));
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const trace = sandbox.traceGitProcesses();
		const second = captured(await captureWorktreeSnapshot(clone, { previous: first.snapshot }));
		assert.equal(started(trace, "cat-file"), 0);
		assert.equal(second.snapshot.delta.base, first.snapshot.id);
	});

	test("that the repository lacks gives a full change set from HEAD", async () => {
		const clone = await cloneWithoutTrustedModes();
		const first = captured(await captureWorktreeSnapshot(clone));
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const missing = { ...first.snapshot, tree: "1".repeat(first.snapshot.tree.length) };
		const second = captured(await captureWorktreeSnapshot(clone, { previous: missing }));
		assert.equal(second.snapshot.delta.base, "head");
		assert.equal(second.snapshot.chain.length, 1);
	});
});
