import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

/** Runs once, right after the next read of a user's index (`.git/index`) by the code under test. */
const hooks = vi.hoisted(() => ({ afterIndexRead: undefined as (() => void) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: async (...args: Parameters<typeof actual.readFile>) => {
			const result = await actual.readFile(...args);
			const path = String(args[0]);
			if (hooks.afterIndexRead !== undefined && basename(path) === "index" && basename(dirname(path)) === ".git") {
				const hook = hooks.afterIndexRead;
				hooks.afterIndexRead = undefined;
				hook();
			}
			return result;
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
