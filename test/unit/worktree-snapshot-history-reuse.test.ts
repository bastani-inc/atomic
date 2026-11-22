import assert from "node:assert/strict";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import type { WorktreeSnapshotOmission } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { GitSandbox, startedGitProcesses } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

/** A cap the bundle of one small commit is far over. */
const SMALL_CAP = 64;

function captured(result: WorktreeSnapshotCapture): Extract<WorktreeSnapshotCapture, { status: "captured" }> {
	assert.equal(result.status, "captured", JSON.stringify(result));
	return result as Extract<WorktreeSnapshotCapture, { status: "captured" }>;
}

function historyOmissions(omitted: readonly WorktreeSnapshotOmission[]): WorktreeSnapshotOmission[] {
	return omitted.filter((omission) => !("path" in omission));
}

/**
 * The Git processes that checked unpushed commits against the deny-list (`diff-tree --stdin`) or bundled them
 * (`bundle create`) since `trace` was last emptied, which empties it again.
 */
function historyWork(trace: string): number {
	if (!existsSync(trace)) return 0;
	const work = startedGitProcesses(trace).filter(({ argv = [] }) => {
		const command = argv.slice(1).filter((arg, index, all) => arg !== "-c" && all[index - 1] !== "-c");
		return (
			(command[0] === "diff-tree" && command.includes("--stdin")) ||
			(command[0] === "bundle" && command[1] === "create")
		);
	}).length;
	rmSync(trace, { force: true });
	return work;
}

/** The `git config` processes started since `trace` was last emptied; it is left as it is. */
function configReads(trace: string): number {
	if (!existsSync(trace)) return 0;
	return startedGitProcesses(trace).filter(({ argv = [] }) => {
		const command = argv.slice(1).filter((arg, index, all) => arg !== "-c" && all[index - 1] !== "-c");
		return command[0] === "config";
	}).length;
}

/**
 * `captureWorktreeSnapshot` of the modules loaded again, as a process that resumes a session loads them, with nothing
 * remembered, its Git traced to `trace`.
 */
async function inNewProcess(): Promise<{
	capture: typeof captureWorktreeSnapshot;
	trace: string;
}> {
	vi.resetModules();
	const capture = await import("../../packages/coding-agent/src/core/worktree-snapshot/capture.ts");
	const git = await import("../../packages/coding-agent/src/core/worktree-snapshot/git.ts");
	const trace = sandbox.path("new-process-trace.jsonl");
	const traced = { ...sandbox.executable, env: { ...sandbox.executable.env, GIT_TRACE2_EVENT: trace } };
	git.setWorktreeSnapshotGit(async () => traced);
	return { capture: capture.captureWorktreeSnapshot, trace };
}

/** A clone whose one unpushed commit adds a file that does not compress to a bundle under {@link SMALL_CAP}. */
async function cloneWithUnpushedData(): Promise<{ clone: string; commit: string; remote: string }> {
	const { clone, remote } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "data.txt"), "unique content that will not compress to nothing\n".repeat(20));
	const commit = await sandbox.commitAll(clone, "data");
	return { clone, commit, remote };
}

describe("unpushed history a capture left out", () => {
	test("a later capture of the same history over the cap records the same omission without bundling it again", async () => {
		const { clone, commit } = await cloneWithUnpushedData();
		const trace = sandbox.traceGitProcesses();
		const settings = { maxSnapshotBytes: SMALL_CAP };
		const first = captured(await captureWorktreeSnapshot(clone, { settings }));
		const [omission] = historyOmissions(first.snapshot.omitted);
		assert.ok(omission?.reason === "bundle-over-cap");
		assert.deepEqual(omission.commits, [commit]);
		assert.ok(historyWork(trace) >= 2, "the first capture checks and bundles the unpushed commit");

		// A capture with no earlier snapshot of its own, as a subagent's first one, after an edit.
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone, { settings }));
		assert.equal(second.snapshot.bundle, null);
		assert.deepEqual(historyOmissions(second.snapshot.omitted), [omission]);
		assert.equal(historyWork(trace), 0);
	});

	test("unpushed history with a denied path is not checked again while it is unchanged", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "secrets", "prod.pem"), "PRIVATE\n");
		const leaking = await sandbox.commitAll(clone, "add pem");
		const trace = sandbox.traceGitProcesses();
		const first = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(first.snapshot.omitted, [
			{ reason: "unpushed-history-denied", commits: [leaking], paths: ["secrets/prod.pem"] },
		]);
		assert.equal(historyWork(trace), 1, "the first capture checks the unpushed commit and bundles nothing");

		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone, { previous: first.snapshot }));
		assert.equal(second.snapshot.bundle, null);
		assert.deepEqual(historyOmissions(second.snapshot.omitted), first.snapshot.omitted);
		assert.equal(historyWork(trace), 0);
	});

	test("a commit on top that adds a denied path has the history checked again", async () => {
		const { clone, commit } = await cloneWithUnpushedData();
		const settings = { maxSnapshotBytes: SMALL_CAP };
		const first = captured(await captureWorktreeSnapshot(clone, { settings }));
		assert.ok(historyOmissions(first.snapshot.omitted)[0]?.reason === "bundle-over-cap");

		sandbox.write(join(clone, "id_rsa"), "PRIVATE KEY\n");
		const leaking = await sandbox.commitAll(clone, "add a key");
		const second = captured(await captureWorktreeSnapshot(clone, { settings, previous: first.snapshot }));
		assert.deepEqual(historyOmissions(second.snapshot.omitted), [
			{ reason: "unpushed-history-denied", commits: [leaking], paths: ["id_rsa"] },
		]);
		assert.notEqual(leaking, commit);
	});

	test("a repack has history over the cap bundled again, as it can make the bundle smaller", async () => {
		const { clone } = await cloneWithUnpushedData();
		const settings = { maxSnapshotBytes: SMALL_CAP };
		captured(await captureWorktreeSnapshot(clone, { settings }));
		await sandbox.git(clone, "repack", "-a", "-d", "-q");

		const trace = sandbox.traceGitProcesses();
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone, { settings }));
		assert.equal(historyOmissions(second.snapshot.omitted)[0]?.reason, "bundle-over-cap");
		assert.ok(historyWork(trace) >= 2, "the commits are checked and bundled again");
	});

	test("a new process bundles history over the cap again rather than take the previous snapshot's size", async () => {
		const { clone } = await cloneWithUnpushedData();
		const settings = { maxSnapshotBytes: SMALL_CAP };
		const first = captured(await captureWorktreeSnapshot(clone, { settings }));
		const [omission] = historyOmissions(first.snapshot.omitted);
		assert.ok(omission?.reason === "bundle-over-cap");

		const { capture, trace } = await inNewProcess();
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await capture(clone, { settings, previous: first.snapshot }));
		assert.equal(historyOmissions(second.snapshot.omitted)[0]?.reason, "bundle-over-cap");
		assert.ok(historyWork(trace) >= 2, "the commits are checked and bundled again");
	});

	test("a new process bundles again when the previous snapshot left out other unpushed commits", async () => {
		const { clone, commit } = await cloneWithUnpushedData();
		const settings = { maxSnapshotBytes: SMALL_CAP };
		const first = captured(await captureWorktreeSnapshot(clone, { settings }));
		assert.ok(historyOmissions(first.snapshot.omitted)[0]?.reason === "bundle-over-cap");
		sandbox.write(join(clone, "more.txt"), "more content that will not compress to nothing either\n".repeat(20));
		const next = await sandbox.commitAll(clone, "more");

		const { capture, trace } = await inNewProcess();
		const second = captured(await capture(clone, { settings, previous: first.snapshot }));
		const [omission] = historyOmissions(second.snapshot.omitted);
		assert.ok(omission?.reason === "bundle-over-cap");
		assert.deepEqual(omission.commits, [next, commit]);
		assert.ok(historyWork(trace) >= 2, "the new commit is checked and bundled with the earlier one");
	});

	test("a push that changes which commits are unpushed has them checked again", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "secrets", "prod.pem"), "PRIVATE\n");
		const leaking = await sandbox.commitAll(clone, "add pem");
		unlinkSync(join(clone, "secrets", "prod.pem"));
		sandbox.write(join(clone, "app.txt"), "app\n");
		const later = await sandbox.commitAll(clone, "remove pem");
		const first = captured(await captureWorktreeSnapshot(clone));
		assert.deepEqual(first.snapshot.omitted, [
			{ reason: "unpushed-history-denied", commits: [leaking], paths: ["secrets/prod.pem"] },
		]);

		// Same HEAD, but the commit with the denied path is now on the remote: only the later one is unpushed.
		await sandbox.git(clone, "push", "-q", "origin", `${leaking}:refs/heads/main`);
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone, { previous: first.snapshot }));
		assert.deepEqual(second.snapshot.omitted, []);
		assert.deepEqual(second.snapshot.bundle?.commits, [later]);
	});

	test("raising the cap above the bundle has the history bundled again", async () => {
		const { clone, commit } = await cloneWithUnpushedData();
		const first = captured(await captureWorktreeSnapshot(clone, { settings: { maxSnapshotBytes: SMALL_CAP } }));
		assert.ok(historyOmissions(first.snapshot.omitted)[0]?.reason === "bundle-over-cap");

		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone, { previous: first.snapshot }));
		assert.deepEqual(historyOmissions(second.snapshot.omitted), []);
		assert.deepEqual(second.snapshot.bundle?.commits, [commit]);
	});

	test("a bundle less than a tenth over the cap is bundled again, as packing the same commits can make it smaller", async () => {
		const { clone } = await cloneWithUnpushedData();
		const measured = historyOmissions(
			captured(await captureWorktreeSnapshot(clone, { settings: { maxSnapshotBytes: SMALL_CAP } })).snapshot.omitted,
		)[0];
		assert.ok(measured?.reason === "bundle-over-cap");
		// Over the cap by 5 percent: the earlier size says the history is left out, but not by enough to trust it.
		const cap = Math.ceil(measured.bytes / 1.05);
		assert.ok(measured.bytes > cap && measured.bytes * 10 <= cap * 11);

		const trace = sandbox.traceGitProcesses();
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const again = captured(await captureWorktreeSnapshot(clone, { settings: { maxSnapshotBytes: cap } }));
		assert.ok(historyWork(trace) >= 1, "the history is bundled again");
		assert.equal(historyOmissions(again.snapshot.omitted)[0]?.reason, "bundle-over-cap");
	});
});

describe("unpushed history over the cap, packed under other settings", () => {
	test("a packing setting changed since the commits were bundled has them bundled again", async () => {
		const { clone } = await sandbox.remoteWithClone();
		// Text that compresses well: uncompressed its bundle is far over the cap, compressed far under it.
		sandbox.write(join(clone, "data.txt"), "a line that repeats and compresses well\n".repeat(4096));
		const commit = await sandbox.commitAll(clone, "data");
		await sandbox.git(clone, "config", "core.compression", "0");
		const settings = { maxSnapshotBytes: 32 * 1024 };
		const first = captured(await captureWorktreeSnapshot(clone, { settings }));
		assert.equal(historyOmissions(first.snapshot.omitted)[0]?.reason, "bundle-over-cap");

		await sandbox.git(clone, "config", "core.compression", "9");
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone, { settings, previous: first.snapshot }));
		assert.deepEqual(historyOmissions(second.snapshot.omitted), []);
		assert.deepEqual(second.snapshot.bundle?.commits, [commit]);
	});

	test("other settings, such as a remote added, keep the commits left out without bundling them again", async () => {
		const { clone } = await cloneWithUnpushedData();
		const trace = sandbox.traceGitProcesses();
		const settings = { maxSnapshotBytes: SMALL_CAP };
		const first = captured(await captureWorktreeSnapshot(clone, { settings }));
		assert.equal(historyOmissions(first.snapshot.omitted)[0]?.reason, "bundle-over-cap");
		historyWork(trace);

		await sandbox.git(clone, "remote", "add", "mirror", "https://example.com/mirror.git");
		await sandbox.git(clone, "config", "user.name", "Someone Else");
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const second = captured(await captureWorktreeSnapshot(clone, { settings }));
		assert.equal(historyOmissions(second.snapshot.omitted)[0]?.reason, "bundle-over-cap");
		assert.equal(historyWork(trace), 0);
	});

	test("a capture whose unpushed commits are bundled and fit reads the repository's config once", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "small.txt"), "small\n");
		await sandbox.commitAll(clone, "small");
		const trace = sandbox.traceGitProcesses();
		const fits = captured(await captureWorktreeSnapshot(clone));
		assert.equal(fits.snapshot.bundle?.commits.length, 1, "the unpushed commit is bundled");
		assert.equal(configReads(trace), 1);
	});

	test("a capture that keeps commits over the cap left out reads the repository's config once", async () => {
		const { clone } = await cloneWithUnpushedData();
		const trace = sandbox.traceGitProcesses();
		const settings = { maxSnapshotBytes: SMALL_CAP };
		captured(await captureWorktreeSnapshot(clone, { settings }));
		historyWork(trace);
		sandbox.write(join(clone, "edit.txt"), "edit\n");
		const reused = captured(await captureWorktreeSnapshot(clone, { settings }));
		assert.equal(historyOmissions(reused.snapshot.omitted)[0]?.reason, "bundle-over-cap");
		assert.equal(configReads(trace), 1);
		assert.equal(historyWork(trace), 0, "the omission is reused");
	});
});
