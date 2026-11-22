import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import type {
	WorktreeSnapshot,
	WorktreeSnapshotOmission,
} from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { GitSandbox, startedGitProcesses } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

/** A cap a commit of {@link LARGE_FILE_BYTES} random bytes bundles far over, and a commit of a short text file under. */
const CAP = 16 * 1024;
const LARGE_FILE_BYTES = 64 * 1024;

type Recorded = Extract<WorktreeSnapshotCapture, { status: "captured" | "unchanged" }>;

function recorded(result: WorktreeSnapshotCapture): Recorded {
	assert.ok(result.status === "captured" || result.status === "unchanged", JSON.stringify(result));
	return result;
}

function historyOmissions(snapshot: WorktreeSnapshot): WorktreeSnapshotOmission[] {
	return snapshot.omitted.filter((omission) => !("path" in omission));
}

/** The Git commands started since `trace` was last emptied, by name, which empties it again. */
function commandsIn(trace: string): string[] {
	if (!existsSync(trace)) return [];
	const commands = startedGitProcesses(trace).map(({ argv = [] }) => {
		const command = argv.slice(1).filter((arg, index, all) => arg !== "-c" && all[index - 1] !== "-c");
		return command[0] ?? "";
	});
	rmSync(trace, { force: true });
	return commands;
}

/** The checks of unpushed commits against the deny-list (`diff-tree --stdin`) started since `trace` was last emptied. */
function denyChecks(trace: string): number {
	if (!existsSync(trace)) return 0;
	return startedGitProcesses(trace).filter(({ argv = [] }) => argv.includes("diff-tree") && argv.includes("--stdin"))
		.length;
}

/** `captureWorktreeSnapshot` of the modules loaded again, as a process that resumes a session loads them. */
async function inNewProcess(trace: string): Promise<typeof captureWorktreeSnapshot> {
	vi.resetModules();
	const capture = await import("../../packages/coding-agent/src/core/worktree-snapshot/capture.ts");
	const git = await import("../../packages/coding-agent/src/core/worktree-snapshot/git.ts");
	const traced = { ...sandbox.executable, env: { ...sandbox.executable.env, GIT_TRACE2_EVENT: trace } };
	git.setWorktreeSnapshotGit(async () => traced);
	return capture.captureWorktreeSnapshot;
}

/** A clone whose two unpushed commits are a large one and, on top of it, a small one. */
async function cloneWithLargeThenSmall(): Promise<{ clone: string; large: string; small: string }> {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "data.bin"), randomBytes(LARGE_FILE_BYTES));
	const large = await sandbox.commitAll(clone, "large");
	sandbox.write(join(clone, "notes.txt"), "small\n");
	const small = await sandbox.commitAll(clone, "small");
	return { clone, large, small };
}

describe("a capture of an unchanged checkout whose unpushed history was left out", () => {
	test("records a snapshot without the omission once the commits over the cap were pushed", async () => {
		const { clone, large, small } = await cloneWithLargeThenSmall();
		const settings = { maxSnapshotBytes: CAP };
		const first = recorded(await captureWorktreeSnapshot(clone, { settings }));
		const [omission] = historyOmissions(first.snapshot);
		assert.ok(omission?.reason === "bundle-over-cap");
		assert.deepEqual(omission.commits, [small, large]);

		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const second = recorded(await captureWorktreeSnapshot(clone, { settings, previous: first.snapshot }));
		assert.equal(second.status, "captured");
		assert.deepEqual(historyOmissions(second.snapshot), []);
		assert.equal(second.snapshot.bundle, null);
		assert.equal(second.snapshot.tree, first.snapshot.tree);
		assert.equal(second.snapshot.delta.base, first.snapshot.id, "it follows the earlier snapshot");
	});

	test("records a snapshot without the omission once the denied commits were pushed", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "secrets", "prod.pem"), "PRIVATE\n");
		const leaking = await sandbox.commitAll(clone, "add pem");
		const first = recorded(await captureWorktreeSnapshot(clone));
		assert.deepEqual(historyOmissions(first.snapshot), [
			{ reason: "unpushed-history-denied", commits: [leaking], paths: ["secrets/prod.pem"] },
		]);

		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const second = recorded(await captureWorktreeSnapshot(clone, { previous: first.snapshot }));
		assert.equal(second.status, "captured");
		assert.deepEqual(historyOmissions(second.snapshot), []);
		assert.equal(second.snapshot.bundle, null);
	});

	test("bundles the commits still unpushed once those over the cap were pushed", async () => {
		const { clone, large, small } = await cloneWithLargeThenSmall();
		const settings = { maxSnapshotBytes: CAP };
		const first = recorded(await captureWorktreeSnapshot(clone, { settings }));
		assert.equal(historyOmissions(first.snapshot)[0]?.reason, "bundle-over-cap");

		await sandbox.git(clone, "push", "-q", "origin", `${large}:main`);
		const second = recorded(await captureWorktreeSnapshot(clone, { settings, previous: first.snapshot }));
		assert.equal(second.status, "captured");
		assert.deepEqual(historyOmissions(second.snapshot), []);
		assert.deepEqual(second.snapshot.bundle?.commits, [small]);
	});

	test("bundles the commits still unpushed once the denied ones were pushed", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "secrets", "prod.pem"), "PRIVATE\n");
		const leaking = await sandbox.commitAll(clone, "add pem");
		sandbox.write(join(clone, "notes.txt"), "later\n");
		const later = await sandbox.commitAll(clone, "later");
		const first = recorded(await captureWorktreeSnapshot(clone));
		assert.equal(historyOmissions(first.snapshot)[0]?.reason, "unpushed-history-denied");

		await sandbox.git(clone, "push", "-q", "origin", `${leaking}:main`);
		const second = recorded(await captureWorktreeSnapshot(clone, { previous: first.snapshot }));
		assert.equal(second.status, "captured");
		assert.deepEqual(historyOmissions(second.snapshot), []);
		assert.deepEqual(second.snapshot.bundle?.commits, [later]);
	});

	test("bundles the commits once the cap was raised above their bundle", async () => {
		const { clone, large, small } = await cloneWithLargeThenSmall();
		const first = recorded(await captureWorktreeSnapshot(clone, { settings: { maxSnapshotBytes: CAP } }));
		const [omission] = historyOmissions(first.snapshot);
		assert.ok(omission?.reason === "bundle-over-cap");

		const settings = { maxSnapshotBytes: omission.bytes * 2 };
		const second = recorded(await captureWorktreeSnapshot(clone, { settings, previous: first.snapshot }));
		assert.equal(second.status, "captured");
		assert.deepEqual(historyOmissions(second.snapshot), []);
		assert.deepEqual(second.snapshot.bundle?.commits, [small, large]);
	});

	test("stays unchanged, listing the unpushed commits only, while they are unchanged and still left out", async () => {
		const overCap = (await cloneWithLargeThenSmall()).clone;
		const denied = (await sandbox.remoteWithClone("denied")).clone;
		sandbox.write(join(denied, "secrets", "prod.pem"), "PRIVATE\n");
		await sandbox.commitAll(denied, "add pem");
		const trace = sandbox.traceGitProcesses();
		for (const [clone, settings, reason] of [
			[overCap, { maxSnapshotBytes: CAP }, "bundle-over-cap"],
			[denied, {}, "unpushed-history-denied"],
		] as const) {
			const first = recorded(await captureWorktreeSnapshot(clone, { settings }));
			assert.deepEqual(
				historyOmissions(first.snapshot).map((omission) => omission.reason),
				[reason],
			);
			commandsIn(trace);
			const second = recorded(await captureWorktreeSnapshot(clone, { settings, previous: first.snapshot }));
			assert.equal(second.status, "unchanged");
			assert.equal(second.snapshot, first.snapshot);
			assert.equal(denyChecks(trace), 0, "the commits this process left out are not checked again");
			const commands = commandsIn(trace);
			assert.equal(commands.filter((command) => command === "rev-list").length, 1, commands.join(" "));
			assert.ok(!commands.includes("bundle") && !commands.includes("commit-tree"), commands.join(" "));
		}
	});

	test("stays unchanged without listing the unpushed commits when the snapshot bundled them", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "notes.txt"), "small\n");
		await sandbox.commitAll(clone, "small");
		const first = recorded(await captureWorktreeSnapshot(clone));
		assert.ok(first.snapshot.bundle !== null);
		const trace = sandbox.traceGitProcesses();
		const second = recorded(await captureWorktreeSnapshot(clone, { previous: first.snapshot }));
		assert.equal(second.status, "unchanged");
		assert.ok(!commandsIn(trace).includes("rev-list"));
	});

	for (const [name, edit] of [
		["matches HEAD", () => {}],
		["has uncommitted changes", (clone: string) => sandbox.write(join(clone, "notes.txt"), "uncommitted\n")],
	] as const) {
		test(`stays unchanged without listing commits when everything is pushed and the checkout ${name}`, async () => {
			const { clone } = await sandbox.remoteWithClone();
			edit(clone);
			const first = recorded(await captureWorktreeSnapshot(clone));
			assert.equal(first.snapshot.bundle, null);
			assert.deepEqual(historyOmissions(first.snapshot), []);
			const trace = sandbox.traceGitProcesses();
			const second = recorded(await captureWorktreeSnapshot(clone, { previous: first.snapshot }));
			assert.equal(second.status, "unchanged");
			const commands = commandsIn(trace);
			assert.ok(!commands.includes("rev-list"), commands.join(" "));
		});
	}

	test("names every denied commit unpushed again after the remote branch moved back", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const initial = await sandbox.git(clone, "rev-parse", "HEAD");
		sandbox.write(join(clone, "secrets", "prod.pem"), "PRIVATE\n");
		const pushed = await sandbox.commitAll(clone, "add prod pem");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		sandbox.write(join(clone, "secrets", "dev.pem"), "PRIVATE\n");
		const unpushed = await sandbox.commitAll(clone, "add dev pem");
		const first = recorded(await captureWorktreeSnapshot(clone));
		assert.deepEqual(historyOmissions(first.snapshot), [
			{ reason: "unpushed-history-denied", commits: [unpushed], paths: ["secrets/dev.pem"] },
		]);

		// The remote branch is forced back to the initial commit: the pushed one is unpushed again.
		await sandbox.git(clone, "push", "-q", "-f", "origin", `${initial}:main`);
		const trace = sandbox.traceGitProcesses();
		const second = recorded(await captureWorktreeSnapshot(clone, { previous: first.snapshot }));
		assert.equal(second.status, "captured");
		assert.deepEqual(historyOmissions(second.snapshot), [
			{
				reason: "unpushed-history-denied",
				commits: [unpushed, pushed],
				paths: ["secrets/dev.pem", "secrets/prod.pem"],
			},
		]);
		assert.equal(second.snapshot.bundle, null);
		assert.equal(denyChecks(trace), 1, "the commits are checked once");
	});

	test("stays unchanged after a new process confirms the denied commits once", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "secrets", "prod.pem"), "PRIVATE\n");
		await sandbox.commitAll(clone, "add pem");
		const first = recorded(await captureWorktreeSnapshot(clone));
		assert.equal(historyOmissions(first.snapshot)[0]?.reason, "unpushed-history-denied");

		const trace = sandbox.path("new-process-trace.jsonl");
		const capture = await inNewProcess(trace);
		const resumed = recorded(await capture(clone, { previous: first.snapshot }));
		assert.equal(resumed.status, "unchanged");
		assert.equal(resumed.snapshot, first.snapshot);
		assert.equal(denyChecks(trace), 1, "a new process checks the commits once");
		assert.ok(!commandsIn(trace).includes("commit-tree"));

		const again = recorded(await capture(clone, { previous: first.snapshot }));
		assert.equal(again.status, "unchanged");
		assert.equal(denyChecks(trace), 0, "and not again while they are the same");
	});
});
