import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox, startedGitProcesses } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionWorktreeSnapshotRecorder } from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { MemorySnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.ts";
import {
	captureLocatedCheckout,
	captureWorktreeSnapshot,
	locateCheckout,
	type WorktreeSnapshotCapture,
} from "../src/core/worktree-snapshot/capture.ts";
import { setWorktreeSnapshotGit } from "../src/core/worktree-snapshot/git.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";

useTemporaryAgentDir();

/**
 * Git processes one turn may start to learn that its checkout did not change: one `rev-parse` locates the checkout,
 * its Git directory, its index and HEAD; the tree is then computed through the private index with `read-tree`,
 * `update-index --refresh`, `diff-files`, `diff-index` (files staged despite an ignore rule), `ls-files --others`,
 * `update-index --stdin` (the files that differ from HEAD), the `config` lookup of the modes Git trusts, and
 * `write-tree`. The session ref already names the snapshot's commit, so it is not written again. Every turn that calls
 * a file-writing tool pays this, in every session of a host: before this budget an unchanged turn started 14, and a
 * host with many agents about 5 Git processes a second.
 */
const UNCHANGED_TURN_GIT_PROCESSES = 9;

/**
 * The `diff-index` that gives changed files the executable or link mode their recorded tree holds, which a capture
 * runs only where Git does not trust the file system's modes (`core.filemode` or `core.symlinks` false), as on
 * Windows (#4932).
 */
const MODE_CARRY_GIT_PROCESSES = 1;

/** Whether Git trusts the file system's executable bits and symbolic links in the checkout at `root`. */
async function trustsFileModes(root: string): Promise<boolean> {
	const setting = (key: string) => sandbox.git(root, "config", "--type=bool", "--default", "true", "--get", key);
	return (await setting("core.filemode")) === "true" && (await setting("core.symlinks")) === "true";
}

/** Git processes that locate a checkout: the one `rev-parse` above. */
const LOCATE_GIT_PROCESSES = 1;

/** Captures of one checkout requested together, as by the sessions of a host's agents that work in it. */
const CONCURRENT_CAPTURES = 6;

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sqlStore(): Promise<SqlSessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

function recorderFor(manager: SessionManager, cwd: string): SessionWorktreeSnapshotRecorder {
	return new SessionWorktreeSnapshotRecorder({
		sessionManager: manager,
		cwd: () => cwd,
		settings: () => DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		declaresWrites: () => false,
		onUnavailable: (reason) => {
			throw reason;
		},
	});
}

const bashTurn = () => fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" });

/**
 * Counts the Git processes snapshot operations start: the resolver is asked once for each. `before(n)` runs before the
 * n-th one starts, which waits for it.
 */
function countGitProcesses(before?: (started: number) => Promise<void>): { readonly count: () => number } {
	let started = 0;
	const executable = sandbox.executable;
	const previous = setWorktreeSnapshotGit(async () => {
		started++;
		await before?.(started);
		return executable;
	});
	cleanups.push(() => {
		setWorktreeSnapshotGit(previous);
	});
	return { count: () => started };
}

describe("the Git processes a turn's snapshot starts", () => {
	test("a turn whose checkout did not change starts at most the unchanged-turn budget of Git processes", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "src/a.txt": "a\n" });
		const manager = await SessionManager.create(await sqlStore(), clone);
		await manager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		const recorder = recorderFor(manager, join(clone, "src"));
		sandbox.write(join(clone, "src", "a.txt"), "changed\n");
		await recorder.recordTurn(bashTurn());
		const recorded = manager.getEntries().filter((entry) => entry.type === "worktree_snapshot");
		assert.equal(recorded.length, 1, "the first turn records a snapshot");

		const budget = UNCHANGED_TURN_GIT_PROCESSES + ((await trustsFileModes(clone)) ? 0 : MODE_CARRY_GIT_PROCESSES);
		const processes = countGitProcesses();
		await recorder.recordTurn(bashTurn());
		const entries = manager.getEntries().filter((entry) => entry.type === "worktree_snapshot");
		assert.equal(entries.length, 2, "the unchanged turn records a reference to the same snapshot");
		assert.equal(entries[1]!.type === "worktree_snapshot" && entries[1]!.snapshot, undefined);
		assert.ok(
			processes.count() <= budget,
			`an unchanged turn started ${processes.count()} Git processes, over ${budget}`,
		);
	});
});

function captured(
	capture: WorktreeSnapshotCapture,
): Extract<WorktreeSnapshotCapture, { status: "captured" | "unchanged" }> {
	if (capture.status !== "captured" && capture.status !== "unchanged") throw new Error(`capture ${capture.status}`);
	return capture;
}

describe("captures of one checkout requested together", () => {
	const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;

	test("compute the checkout's tree at most twice, and each records the same snapshot", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		sandbox.write(join(clone, "README.md"), "edited\n");
		const blobs = new MemorySnapshotBlobStore();
		const first = captured(await captureWorktreeSnapshot(clone, { settings, blobs }));
		const alone = countGitProcesses();
		assert.equal(
			(await captureWorktreeSnapshot(clone, { settings, blobs, previous: first.snapshot })).status,
			"unchanged",
		);
		const treeProcesses = alone.count() - LOCATE_GIT_PROCESSES;
		cleanups.pop()?.();

		const together = countGitProcesses();
		const captures = await Promise.all(
			Array.from({ length: CONCURRENT_CAPTURES }, () =>
				captureWorktreeSnapshot(clone, { settings, blobs, previous: first.snapshot }),
			),
		);
		assert.deepEqual(
			captures.map((capture) => [capture.status, captured(capture).snapshot.id]),
			captures.map(() => ["unchanged", first.snapshot.id]),
		);
		assert.ok(
			together.count() <= CONCURRENT_CAPTURES * LOCATE_GIT_PROCESSES + 2 * treeProcesses,
			`${CONCURRENT_CAPTURES} captures started ${together.count()} Git processes; computing the tree takes ${treeProcesses}`,
		);
	});

	test("a capture requested while the checkout's tree is being computed records the files as they are after its request", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		const blobs = new MemorySnapshotBlobStore();
		const recorded = captured(await captureWorktreeSnapshot(clone, { settings, blobs }));
		const checkout = await locateCheckout(clone);
		if (checkout instanceof Error) throw checkout;
		let reading!: () => void;
		const readingStarted = new Promise<void>((resolve) => {
			reading = resolve;
		});
		let resume!: () => void;
		const resumed = new Promise<void>((resolve) => {
			resume = resolve;
		});
		// The first capture's sixth Git process, the lookup of the modes Git trusts, runs after its tree computation
		// listed the changed and untracked files, and before it writes the tree.
		countGitProcesses(async (started) => {
			if (started !== 6) return;
			reading();
			await resumed;
		});
		const running = captureLocatedCheckout(checkout, { settings, blobs, previous: recorded.snapshot });
		await readingStarted;
		sandbox.write(join(clone, "late.txt"), "written while the first capture ran\n");
		const later = [
			captureLocatedCheckout(checkout, { settings, blobs, previous: recorded.snapshot }),
			captureLocatedCheckout(checkout, { settings, blobs, previous: recorded.snapshot }),
		];
		await new Promise((resolve) => setTimeout(resolve, 50));
		resume();
		const [first, ...requestedLater] = await Promise.all([running, ...later]);
		assert.equal(first!.status, "unchanged", "the running capture listed the files before the write");
		for (const capture of requestedLater) {
			const { snapshot } = captured(capture);
			assert.equal(capture.status, "captured");
			assert.equal(
				await sandbox.git(clone, "cat-file", "-p", `${snapshot.tree}:late.txt`),
				"written while the first capture ran",
			);
		}
	});

	/** A checkout edited after each of `count` captures, each from the one before, and edited once more. */
	async function checkoutWithEarlierSnapshots(count: number, fileMode: boolean) {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "run.sh": "echo\n" });
		if (!fileMode) await sandbox.git(clone, "config", "core.filemode", "false");
		const blobs = new MemorySnapshotBlobStore();
		const earlier: WorktreeSnapshotCapture[] = [];
		for (let index = 0; index < count; index++) {
			sandbox.write(join(clone, `step-${index}.txt`), "step\n");
			const previous = earlier.at(-1);
			earlier.push(
				await captureWorktreeSnapshot(clone, {
					settings,
					blobs,
					...(previous ? { previous: captured(previous).snapshot } : {}),
				}),
			);
		}
		sandbox.write(join(clone, "README.md"), "together\n");
		return { clone, blobs, earlier: earlier.map((capture) => captured(capture).snapshot) };
	}

	function startedWith(trace: string, command: string): number {
		return startedGitProcesses(trace).filter((event) => event.argv?.includes(command)).length;
	}

	test("from different earlier snapshots compute the checkout's tree at most twice where Git trusts file modes, and each records its own chain", async () => {
		const { clone, blobs, earlier } = await checkoutWithEarlierSnapshots(CONCURRENT_CAPTURES, true);
		const trace = sandbox.traceGitProcesses();
		const captures = await Promise.all(
			earlier.map((previous) => captureWorktreeSnapshot(clone, { settings, blobs, previous })),
		);
		assert.ok(startedWith(trace, "write-tree") <= 2, `${startedWith(trace, "write-tree")} trees written`);
		const snapshots = captures.map((capture) => captured(capture).snapshot);
		assert.equal(new Set(snapshots.map((snapshot) => snapshot.tree)).size, 1, "one tree");
		assert.deepEqual(
			snapshots.map((snapshot) => snapshot.delta.base),
			earlier.map((previous) => previous.id),
			"each snapshot follows its own earlier one",
		);
	});

	test("from different earlier snapshots each compute the tree where Git does not trust file modes", async () => {
		const { clone, blobs, earlier } = await checkoutWithEarlierSnapshots(3, false);
		const trace = sandbox.traceGitProcesses();
		await Promise.all(earlier.map((previous) => captureWorktreeSnapshot(clone, { settings, blobs, previous })));
		assert.equal(startedWith(trace, "write-tree"), 3);
	});

	test("captures of different checkouts requested together each record their own checkout", async () => {
		const one = (await sandbox.remoteWithClone("one", { "README.md": "one\n" })).clone;
		const two = (await sandbox.remoteWithClone("two", { "README.md": "two\n" })).clone;
		sandbox.write(join(one, "README.md"), "one edited\n");
		sandbox.write(join(two, "README.md"), "two edited\n");
		const blobs = new MemorySnapshotBlobStore();
		const [first, second] = await Promise.all([
			captureWorktreeSnapshot(one, { settings, blobs }),
			captureWorktreeSnapshot(two, { settings, blobs }),
		]);
		assert.equal(
			await sandbox.git(one, "cat-file", "-p", `${captured(first!).snapshot.tree}:README.md`),
			"one edited",
		);
		assert.equal(
			await sandbox.git(two, "cat-file", "-p", `${captured(second!).snapshot.tree}:README.md`),
			"two edited",
		);
	});
});
