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
	nextCaptureTick,
	recordRestoredTree,
	type WorktreeSnapshotCapture,
} from "../src/core/worktree-snapshot/capture.ts";
import { gitText, runGit, setWorktreeSnapshotGit } from "../src/core/worktree-snapshot/git.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";

useTemporaryAgentDir();

/**
 * Git processes one turn may start to learn that its checkout did not change: one `rev-parse` locates the checkout,
 * its Git directory, its index and HEAD; one `status` lists the files that differ from HEAD and the untracked ones
 * through the private index, which still holds HEAD's tree, so it is not read again (a checkout with submodules adds
 * `update-index --refresh` and `diff-files`, which look into them); `update-index --stdin` adds the
 * files that differ from HEAD to a copy of it, and `write-tree` writes the tree. The files staged in the user's index
 * despite an ignore rule (`diff-index`) were listed by the turn before, from the same index and HEAD. The session ref
 * already names the snapshot's commit, so it is not written again. Every turn that calls a file-writing tool pays
 * this, in every session of a host: before this budget an unchanged turn started 14, then 8, and a host with many
 * agents about 5 Git processes a second. On Windows each process takes 25 to 45 ms to start.
 */
const UNCHANGED_TURN_GIT_PROCESSES = 4;

/** Of those, the ones an unchanged turn starts when no file differs from HEAD: the lookup and the `status`. */
const CLEAN_TURN_GIT_PROCESSES = 2;

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

	test("a turn whose checkout still matches HEAD starts only the lookup and one status", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "src/a.txt": "a\n" });
		const manager = await SessionManager.create(await sqlStore(), clone);
		await manager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		const recorder = recorderFor(manager, clone);
		await recorder.recordTurn(bashTurn());
		const trace = sandbox.traceGitProcesses();
		await recorder.recordTurn(bashTurn());
		const entries = manager.getEntries().filter((entry) => entry.type === "worktree_snapshot");
		assert.equal(entries.length, 2, "the unchanged turn records a reference to the same snapshot");
		const commands = startedGitProcesses(trace).map(({ argv = [] }) =>
			argv.filter((arg) => !arg.includes("=")).at(-1),
		);
		assert.equal(
			startedGitProcesses(trace).length,
			CLEAN_TURN_GIT_PROCESSES,
			`an unchanged turn of a clean checkout started ${JSON.stringify(commands)}`,
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
		// A file that differs from HEAD, so each capture writes its tree after listing the files.
		sandbox.write(join(clone, "README.md"), "edited\n");
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
		// The first capture's second Git process, `update-index`, runs after its `status` listed the changed and untracked
		// files (the files staged despite an ignore rule were listed by the capture before, from the same index).
		countGitProcesses(async (started) => {
			if (started !== 2) return;
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
		// Git for Windows writes both as false into a new repository's config: the test says which it trusts.
		await sandbox.git(clone, "config", "core.filemode", String(fileMode));
		await sandbox.git(clone, "config", "core.symlinks", String(fileMode));
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

	test("from different earlier snapshots compute the checkout's tree at most twice where Git does not trust file modes either", async () => {
		const { clone, blobs, earlier } = await checkoutWithEarlierSnapshots(CONCURRENT_CAPTURES, false);
		const trace = sandbox.traceGitProcesses();
		const captures = await Promise.all(
			earlier.map((previous) => captureWorktreeSnapshot(clone, { settings, blobs, previous })),
		);
		assert.ok(startedWith(trace, "write-tree") <= 2, `${startedWith(trace, "write-tree")} trees written`);
		assert.deepEqual(
			captures.map((capture) => captured(capture).snapshot.delta.base),
			earlier.map((previous) => previous.id),
		);
	});

	test("where Git does not trust file modes, captures from earlier snapshots with other modes share the scan, and each keeps the modes of its own", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
		await sandbox.git(clone, "config", "core.filemode", "false");
		await sandbox.git(clone, "config", "core.symlinks", "false");
		sandbox.write(join(clone, "tool.sh"), "echo\n");
		const blobs = new MemorySnapshotBlobStore();
		const plain = captured(await captureWorktreeSnapshot(clone, { settings, blobs })).snapshot;
		// The checkout was restored from a snapshot that recorded tool.sh as executable, as one taken where Git trusts
		// modes does: a capture with no earlier snapshot of its own keeps that mode, one from `plain` keeps its own.
		const index = sandbox.path("mode-index");
		const git = { cwd: clone, env: { GIT_INDEX_FILE: index } };
		await runGit(["read-tree", plain.tree], git);
		await runGit(["update-index", "--chmod=+x", "--", "tool.sh"], git);
		await recordRestoredTree({ cwd: clone }, await gitText(["write-tree"], git));
		sandbox.write(join(clone, "README.md"), "changed\n");
		const checkout = await locateCheckout(clone);
		if (checkout instanceof Error) throw checkout;

		const trace = sandbox.path("git-trace.jsonl");
		const traced = { ...sandbox.executable, env: { ...sandbox.executable.env, GIT_TRACE2_EVENT: trace } };
		const scanning = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let started = 0;
		const previous = setWorktreeSnapshotGit(async () => {
			started++;
			// The first capture's third Git process, `write-tree`, runs once its scan listed the changed files (the files
			// staged despite an ignore rule were listed by the capture of `plain`, from the same index and HEAD).
			if (started === 3) {
				scanning.resolve();
				await resume.promise;
			}
			return traced;
		});
		cleanups.push(() => {
			setWorktreeSnapshotGit(previous);
		});
		const first = captureLocatedCheckout(checkout, { settings, blobs, previous: plain });
		await scanning.promise;
		const restoredModes = captureLocatedCheckout(checkout, { settings, blobs });
		const ownModes = captureLocatedCheckout(checkout, { settings, blobs, previous: plain });
		await new Promise((resolve) => setTimeout(resolve, 50));
		resume.resolve();
		const [, executable, regular] = (await Promise.all([first, restoredModes, ownModes])).map(
			(capture) => captured(capture).snapshot,
		);
		const scans = startedGitProcesses(trace).filter((event) => event.argv?.includes("status")).length;
		assert.equal(scans, 2, "the two later captures share one scan");
		const modeOf = async (tree: string) => (await sandbox.git(clone, "ls-tree", tree, "tool.sh")).split(" ")[0];
		assert.equal(await modeOf(executable!.tree), "100755");
		assert.equal(await modeOf(regular!.tree), "100644");
	});

	/**
	 * Captures `earlier[0]`'s session's checkout and, once that capture's scan of the working files started, requests a
	 * capture from `earlier[1]` whose writes ended at the tick `wroteBy` gives, before or after that start. Every Git
	 * process the snapshot runner starts is traced; the first capture's third one, its scan's `write-tree`, runs once
	 * the scan listed the changed files, and waits until the second capture was requested. The files staged despite an
	 * ignore rule were listed by the earlier captures, from the same index and HEAD.
	 */
	async function captureDuringScan(wroteBy: (scanStarted: boolean) => number) {
		const { clone, blobs, earlier } = await checkoutWithEarlierSnapshots(2, true);
		const checkout = await locateCheckout(clone);
		if (checkout instanceof Error) throw checkout;
		const trace = sandbox.path("git-trace.jsonl");
		const traced = { ...sandbox.executable, env: { ...sandbox.executable.env, GIT_TRACE2_EVENT: trace } };
		const scanning = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let started = 0;
		const previous = setWorktreeSnapshotGit(async () => {
			started++;
			if (started === 3) {
				scanning.resolve();
				await resume.promise;
			}
			return traced;
		});
		cleanups.push(() => {
			setWorktreeSnapshotGit(previous);
		});
		const before = wroteBy(false);
		const first = captureLocatedCheckout(checkout, { settings, blobs, previous: earlier[0] });
		await scanning.promise;
		const tick = wroteBy(true) || before;
		const second = captureLocatedCheckout(checkout, { settings, blobs, previous: earlier[1] }, tick);
		await new Promise((resolve) => setTimeout(resolve, 50));
		resume.resolve();
		const [one, two] = (await Promise.all([first, second])).map((capture) => captured(capture).snapshot);
		assert.equal(two!.tree, one!.tree);
		assert.deepEqual(
			[one!.delta.base, two!.delta.base],
			earlier.map((snapshot) => snapshot.id),
			"each its own chain",
		);
		return startedWith(trace, "write-tree");
	}

	test("a capture takes the tree of a scan that started after its writes ended", async () => {
		const trees = await captureDuringScan((scanStarted) => (scanStarted ? 0 : nextCaptureTick()));
		assert.equal(trees, 1);
	});

	test("a capture does not take the tree of a scan that started before its writes ended", async () => {
		const trees = await captureDuringScan((scanStarted) => (scanStarted ? nextCaptureTick() : 0));
		assert.equal(trees, 2);
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
