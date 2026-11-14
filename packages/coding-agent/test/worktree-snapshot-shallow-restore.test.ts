import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox, loseSnapshotBlobs } from "../../../test/helpers/worktree-snapshot.js";
import { prepareSessionResume } from "../src/core/resume/session-resume.js";
import { SessionManager } from "../src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { MemorySnapshotBlobStore, type SqlSnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { runGit, setWorktreeSnapshotGit } from "../src/core/worktree-snapshot/git.js";
import {
	isHeadOnlyAdvance,
	isWorkspaceRestoreError,
	restoreDegradedWorktree,
	restoreWorktree,
	WorkspaceDriftError,
	type WorkspaceRestoreError,
} from "../src/core/worktree-snapshot/index.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
/** Commits in the long history the depth-1 fetch skips, as spec S3 sets it (#4748). */
const HISTORY_COMMITS = 300;
/** Incompressible bytes each historical commit adds, so the full history is much larger than one commit's tree. */
const BYTES_PER_COMMIT = 4096;
let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

/** A bare remote whose `main` has `commits` commits, each rewriting `history.bin`, and a `file://` clone of it. */
async function longHistory(commits = HISTORY_COMMITS) {
	const remote = sandbox.path("long.git");
	await sandbox.git(sandbox.root, "init", "-q", "--bare", remote);
	const parts: string[] = [];
	for (let index = 1; index <= commits; index++) {
		const message = `commit ${index}\n`;
		const content = randomBytes(BYTES_PER_COMMIT).toString("base64");
		parts.push(
			`commit refs/heads/main\ncommitter Fixture <fixture@example.com> ${1_700_000_000 + index} +0000\n`,
			`data ${Buffer.byteLength(message)}\n${message}`,
			`M 100644 inline README.md\ndata 6\nhello\nM 100644 inline history.bin\ndata ${content.length}\n${content}\n`,
		);
	}
	await runGit(["fast-import", "--quiet"], { cwd: sandbox.root, env: { GIT_DIR: remote }, input: parts.join("") });
	const url = pathToFileURL(remote).href;
	const clone = sandbox.path("long");
	await sandbox.git(sandbox.root, "clone", "-q", url, clone);
	return { remote, url, clone };
}

async function capture(root: string, blobs: MemorySnapshotBlobStore): Promise<WorktreeSnapshot> {
	const captured = await captureWorktreeSnapshot(root, { settings, blobs });
	if (captured.status !== "captured") throw new Error(captured.status);
	return captured.snapshot;
}

/** The one shared object store under `storeDir`. */
function storeOf(storeDir: string): string {
	const [name] = readdirSync(join(storeDir, "repositories")).filter((entry) => entry.endsWith(".git"));
	return join(storeDir, "repositories", name!);
}

async function inStore(store: string, ...args: string[]): Promise<string> {
	const { stdout } = await runGit(args, { cwd: sandbox.root, env: { GIT_DIR: store } });
	return stdout.toString("utf8").trim();
}

/** The bytes of every file under `dir`. */
function diskBytes(dir: string): number {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
	}
	return total;
}

/** A Git that fails every `fetch --depth`, as a Git or remote that refuses shallow fetches does, and runs the real Git otherwise. */
function gitRefusingDepth(): { path: string; env: Readonly<NodeJS.ProcessEnv> } {
	const shim = sandbox.path("git-refusing-depth");
	writeFileSync(
		shim,
		`#!/bin/sh\nfor arg in "$@"; do case "$arg" in --depth*) echo "fatal: shallow fetch refused" >&2; exit 128;; esac; done\nexec git "$@"\n`,
	);
	chmodSync(shim, 0o755);
	return { path: shim, env: sandbox.executable.env };
}

describe("a cold restore fetches the snapshot's commit at depth 1 (#4748)", () => {
	test("the store is shallow after a cold restore from a 300-commit file:// remote and holds one commit (#4748)", async () => {
		const { clone } = await longHistory();
		sandbox.write(join(clone, "README.md"), "edited\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const storeDir = sandbox.path("host");

		const restored = await restoreWorktree(snapshot, { blobs, storeDir });

		const store = storeOf(storeDir);
		assert.equal(await inStore(store, "rev-parse", "--is-shallow-repository"), "true");
		assert.equal(await inStore(store, "rev-list", "--count", snapshot.head), "1");
		assert.equal(readFileSync(join(store, "shallow"), "utf8").trim(), snapshot.head);
		assert.equal(readFileSync(join(restored.path, "README.md"), "utf8"), "edited\n");
		assert.equal(await sandbox.git(restored.path, "rev-parse", "HEAD"), snapshot.head);
		// #4732: the restored store still names the recorded remotes and marks the fetched commit as pushed.
		assert.deepEqual(snapshot.remotes, [await inStore(store, "remote", "get-url", "origin")]);
		assert.equal(await inStore(store, "rev-parse", `refs/remotes/atomic/pushed/${snapshot.head}`), snapshot.head);
	});

	test.skipIf(process.platform === "win32")(
		"benchmark: the depth-1 store is at most half the size of a full fetch's and restores no slower than 1.5x of it (#4748)",
		async () => {
			const { clone } = await longHistory();
			const blobs = new MemorySnapshotBlobStore();
			const snapshot = await capture(clone, blobs);

			const fullStarted = performance.now();
			await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("full"), git: gitRefusingDepth() });
			const fullMs = performance.now() - fullStarted;
			const shallowStarted = performance.now();
			await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("shallow") });
			const shallowMs = performance.now() - shallowStarted;

			const fullBytes = diskBytes(join(sandbox.path("full"), "repositories"));
			const shallowBytes = diskBytes(join(sandbox.path("shallow"), "repositories"));
			assert.ok(shallowBytes <= fullBytes * 0.5, `shallow store ${shallowBytes} B, full store ${fullBytes} B`);
			assert.ok(shallowMs <= fullMs * 1.5, `shallow restore ${shallowMs} ms, full restore ${fullMs} ms`);
		},
	);

	test.skipIf(process.platform === "win32")(
		"a Git that refuses --depth gets today's full fetch, and the restore succeeds (#4748)",
		async () => {
			const { clone } = await longHistory(20);
			sandbox.write(join(clone, "README.md"), "edited\n");
			const blobs = new MemorySnapshotBlobStore();
			const snapshot = await capture(clone, blobs);
			const storeDir = sandbox.path("host");

			const restored = await restoreWorktree(snapshot, { blobs, storeDir, git: gitRefusingDepth() });

			const store = storeOf(storeDir);
			assert.equal(await inStore(store, "rev-parse", "--is-shallow-repository"), "false");
			assert.equal(await inStore(store, "rev-list", "--count", snapshot.head), "20");
			assert.equal(readFileSync(join(restored.path, "README.md"), "utf8"), "edited\n");
		},
	);

	test.skipIf(process.platform === "win32")(
		"a remote that lacks the snapshot's commit is asked for it once, not again without --depth (#4748)",
		async () => {
			const { clone } = await longHistory(3);
			sandbox.write(join(clone, "unpushed.txt"), "unpushed\n");
			const head = await sandbox.commitAll(clone, "unpushed");
			const blobs = new MemorySnapshotBlobStore();
			const snapshot = await capture(clone, blobs);
			const log = sandbox.path("fetches.log");
			const shim = sandbox.path("git-logging");
			writeFileSync(shim, `#!/bin/sh\ncase " $* " in *" fetch "*) echo "$*" >> "${log}";; esac\nexec git "$@"\n`);
			chmodSync(shim, 0o755);

			const restored = await restoreWorktree(snapshot, {
				blobs,
				storeDir: sandbox.path("host"),
				git: { path: shim, env: sandbox.executable.env },
			});

			assert.equal(await sandbox.git(restored.path, "rev-parse", "HEAD"), head);
			const headFetches = readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.filter((line) => line.endsWith(` ${head}`));
			assert.equal(headFetches.length, 1, headFetches.join("\n"));
			assert.match(headFetches[0]!, / --depth=1 /);
		},
	);

	test("a snapshot's bundled commit that was pushed since is fetched at depth 1 and marked as pushed (#4748)", async () => {
		const { clone } = await longHistory(3);
		sandbox.write(join(clone, "later.txt"), "pushed after the capture\n");
		const head = await sandbox.commitAll(clone, "pushed after the capture");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.deepEqual(snapshot.bundle?.commits, [head]);
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const storeDir = sandbox.path("host");

		await restoreWorktree(snapshot, { blobs, storeDir });

		const store = storeOf(storeDir);
		assert.equal(readFileSync(join(store, "shallow"), "utf8").trim(), head);
		assert.equal(await inStore(store, "rev-parse", `refs/remotes/atomic/pushed/${head}`), head);
	});

	test("a bundle whose prerequisite is two commits below a shallow store's boundary unshallows the store and restores (#4748)", async () => {
		const { clone } = await longHistory(5);
		const blobs = new MemorySnapshotBlobStore();
		const storeDir = sandbox.path("host");
		await restoreWorktree(await capture(clone, blobs), { blobs, storeDir });
		const store = storeOf(storeDir);
		assert.equal(await inStore(store, "rev-parse", "--is-shallow-repository"), "true");
		const base = await sandbox.git(clone, "rev-parse", "HEAD~2");
		await sandbox.git(clone, "checkout", "-q", "--detach", base);
		sandbox.write(join(clone, "unpushed.txt"), "unpushed\n");
		const head = await sandbox.commitAll(clone, "unpushed on an older commit");
		const snapshot = await capture(clone, blobs);
		assert.deepEqual(snapshot.bundle?.commits, [head]);

		const restored = await restoreWorktree(snapshot, { blobs, storeDir });

		assert.equal(await inStore(store, "rev-parse", "--is-shallow-repository"), "false");
		assert.equal(await sandbox.git(restored.path, "rev-parse", "HEAD"), head);
		assert.equal(readFileSync(join(restored.path, "unpushed.txt"), "utf8"), "unpushed\n");
		// #4732: the bundle's pushed boundary is marked as pushed, the bundled commit is not.
		assert.equal(await inStore(store, "rev-parse", `refs/remotes/atomic/pushed/${base}`), base);
		assert.equal(
			(
				await runGit(["rev-parse", "-q", "--verify", `refs/remotes/atomic/pushed/${head}`], {
					cwd: sandbox.root,
					env: { GIT_DIR: store },
					allowExitCodes: [1],
				})
			).exitCode,
			1,
		);
	});

	test("a degraded restore of an older candidate still works after a shallow restore, and lists only missing commits (#4748)", async () => {
		const { clone } = await longHistory(5);
		const blobs = new MemorySnapshotBlobStore();
		const storeDir = sandbox.path("host");
		await restoreWorktree(await capture(clone, blobs), { blobs, storeDir });
		const older = await sandbox.git(clone, "rev-parse", "HEAD~3");
		sandbox.write(join(clone, "unpushed.txt"), "unpushed\n");
		const head = await sandbox.commitAll(clone, "unpushed");
		const snapshot = await capture(clone, blobs);
		await loseSnapshotBlobs(blobs, [snapshot.bundle!.blob]);
		const failure = await restoreWorktree(snapshot, { blobs, storeDir }).then(
			() => assert.fail("the exact restore needs the lost bundle"),
			(error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error), String(error));
				return error as WorkspaceRestoreError;
			},
		);
		// The bundle's pushed base is unreadable, so the earlier snapshot's commit below the boundary is the candidate.
		const pushedTip = await sandbox.git(clone, "rev-parse", "HEAD~1");
		await sandbox.git(sandbox.path("long.git"), "update-ref", "refs/heads/main", older);
		await sandbox.git(sandbox.path("long.git"), "update-ref", "refs/heads/old-tip", pushedTip);

		const degraded = await restoreDegradedWorktree(snapshot, failure, { blobs, storeDir, candidates: [older] });

		assert.equal(degraded.degraded.stage, "closest-commit");
		assert.equal(degraded.degraded.head, older);
		assert.equal(await sandbox.git(degraded.path, "rev-parse", "HEAD"), older);
		assert.deepEqual(degraded.degraded.missingCommits, [head]);
		assert.equal(await inStore(storeOf(storeDir), "rev-parse", "--is-shallow-repository"), "false");
	});
});

describe("ancestry across a shallow store's boundary (#4748)", () => {
	test("a degraded restore at a commit a depth-1 restore left shallow lists only the commits its history lacks (#4748)", async () => {
		const { clone } = await longHistory(3);
		const blobs = new MemorySnapshotBlobStore();
		sandbox.write(join(clone, "pushed-later.txt"), "pushed later\n");
		const pushedLater = await sandbox.commitAll(clone, "unpushed, pushed later");
		sandbox.write(join(clone, "unpushed.txt"), "unpushed\n");
		const head = await sandbox.commitAll(clone, "never pushed");
		const snapshot = await capture(clone, blobs);
		assert.deepEqual([...snapshot.bundle!.commits].sort(), [pushedLater, head].sort());
		await loseSnapshotBlobs(blobs, [snapshot.bundle!.blob]);
		await sandbox.git(clone, "checkout", "-q", "--detach", pushedLater);
		await sandbox.git(clone, "commit", "-q", "--allow-empty", "-m", "on top of the pushed commit");
		const tip = await sandbox.git(clone, "rev-parse", "HEAD");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const storeDir = sandbox.path("host");
		await restoreWorktree(await capture(clone, blobs), { blobs, storeDir });
		assert.equal(await inStore(storeOf(storeDir), "rev-parse", "--is-shallow-repository"), "true");
		const failure = await restoreWorktree(snapshot, { blobs, storeDir }).then(
			() => assert.fail("the exact restore needs the lost bundle"),
			(error: unknown) => error as WorkspaceRestoreError,
		);

		const degraded = await restoreDegradedWorktree(snapshot, failure, { blobs, storeDir, candidates: [tip] });

		assert.equal(degraded.degraded.head, tip);
		assert.deepEqual(degraded.degraded.missingCommits, [head]);
	});

	test("a HEAD that advanced from a recorded commit below the depth-1 boundary is a head-only advance (#4748)", async () => {
		const { clone } = await longHistory(5);
		const blobs = new MemorySnapshotBlobStore();
		const restored = await restoreWorktree(await capture(clone, blobs), { blobs, storeDir: sandbox.path("host") });
		const head = await sandbox.git(restored.path, "rev-parse", "HEAD");
		const tree = await sandbox.git(restored.path, "rev-parse", "HEAD^{tree}");
		const older = await sandbox.git(clone, "rev-parse", "HEAD~2");
		const drift = new WorkspaceDriftError({
			root: restored.path,
			expectedHead: older,
			actualHead: head,
			expectedTree: tree,
			actualTree: tree,
			snapshotId: null,
		});

		assert.equal(await isHeadOnlyAdvance(drift), true);
	});

	test("sibling restored worktrees of one shallow store are both advances when checked at once (#4748)", async () => {
		const { clone } = await longHistory(5);
		const blobs = new MemorySnapshotBlobStore();
		const storeDir = sandbox.path("host");
		const snapshot = await capture(clone, blobs);
		const worktrees = [
			await restoreWorktree(snapshot, { blobs, storeDir }),
			await restoreWorktree(snapshot, { blobs, storeDir }),
		];
		const older = await sandbox.git(clone, "rev-parse", "HEAD~2");
		const drifts = worktrees.map(
			(restored) =>
				new WorkspaceDriftError({
					root: restored.path,
					expectedHead: older,
					actualHead: snapshot.head,
					expectedTree: snapshot.tree,
					actualTree: snapshot.tree,
					snapshotId: null,
				}),
		);

		assert.deepEqual(await Promise.all(drifts.map((drift) => isHeadOnlyAdvance(drift))), [true, true]);
	});

	test("a restored worktree whose remote is gone keeps its shallow store, and ancestry below the boundary is not an advance (#4748)", async () => {
		const { remote, clone } = await longHistory(5);
		const blobs = new MemorySnapshotBlobStore();
		const storeDir = sandbox.path("host");
		const restored = await restoreWorktree(await capture(clone, blobs), { blobs, storeDir });
		const tree = await sandbox.git(restored.path, "rev-parse", "HEAD^{tree}");
		const drift = new WorkspaceDriftError({
			root: restored.path,
			expectedHead: await sandbox.git(clone, "rev-parse", "HEAD~2"),
			actualHead: await sandbox.git(restored.path, "rev-parse", "HEAD"),
			expectedTree: tree,
			actualTree: tree,
			snapshotId: null,
		});
		renameSync(remote, sandbox.path("remote-gone.git"));

		assert.equal(await isHeadOnlyAdvance(drift), false);
		assert.equal(await inStore(storeOf(storeDir), "rev-parse", "--is-shallow-repository"), "true");
	});

	test("a recorded commit the whole history shows is not an ancestor is not an advance (#4748)", async () => {
		const { clone } = await longHistory(5);
		const blobs = new MemorySnapshotBlobStore();
		const storeDir = sandbox.path("host");
		const restored = await restoreWorktree(await capture(clone, blobs), { blobs, storeDir });
		const head = await sandbox.git(restored.path, "rev-parse", "HEAD");
		await sandbox.git(clone, "checkout", "-q", "--detach", "HEAD~2");
		sandbox.write(join(clone, "side.txt"), "side\n");
		const side = await sandbox.commitAll(clone, "a side branch");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:refs/heads/side");
		const tree = await sandbox.git(restored.path, "rev-parse", "HEAD^{tree}");
		const drift = new WorkspaceDriftError({
			root: restored.path,
			expectedHead: side,
			actualHead: head,
			expectedTree: tree,
			actualTree: tree,
			snapshotId: null,
		});

		assert.equal(await isHeadOnlyAdvance(drift), false);
		assert.equal(await inStore(storeOf(storeDir), "rev-parse", "--is-shallow-repository"), "false");
	});

	test("a drift reported for a directory that is no longer a repository is not an advance (#4748)", async () => {
		const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
		const drift = new WorkspaceDriftError({
			root: sandbox.root,
			expectedHead: "a".repeat(40),
			actualHead: "b".repeat(40),
			expectedTree: tree,
			actualTree: tree,
			snapshotId: null,
		});

		assert.equal(await isHeadOnlyAdvance(drift), false);
	});

	test("a user's own shallow clone is never deepened: ancestry below its boundary is not an advance (#4748)", async () => {
		const { url, clone } = await longHistory(5);
		const shallow = sandbox.path("user-shallow");
		await sandbox.git(sandbox.root, "clone", "-q", "--depth=1", url, shallow);
		const tree = await sandbox.git(shallow, "rev-parse", "HEAD^{tree}");
		const drift = new WorkspaceDriftError({
			root: shallow,
			expectedHead: await sandbox.git(clone, "rev-parse", "HEAD~2"),
			actualHead: await sandbox.git(shallow, "rev-parse", "HEAD"),
			expectedTree: tree,
			actualTree: tree,
			snapshotId: null,
		});

		assert.equal(await isHeadOnlyAdvance(drift), false);
		assert.equal(existsSync(join(shallow, ".git", "shallow")), true);
	});
});

/** A session working in `first`, which also recorded edited snapshots of `others`, each a clone of its own repository. */
async function sessionWithOptionalCheckouts(first: string, others: readonly string[]): Promise<SessionManager> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, first);
	await manager.appendMessage({ role: "user", content: "edit the files", timestamp: Date.now() });
	for (const root of [first, ...others]) {
		sandbox.write(join(root, "README.md"), `edited ${root}\n`);
		const captured = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
		if (captured.status !== "captured") throw new Error(captured.status);
		await manager.appendWorktreeSnapshot(root, captured.snapshot.id, captured.snapshot);
	}
	return manager;
}

/**
 * A Git that appends `start <remote>` and, a moment after the real Git finishes (longer for `second.git`), `end <remote>`
 * for each fetch to `log`.
 */
function gitLoggingFetches(log: string): { path: string; env: Readonly<NodeJS.ProcessEnv> } {
	const shim = sandbox.path("git-logging-fetches");
	writeFileSync(
		shim,
		[
			"#!/bin/sh",
			'case " $* " in *" fetch "*) ;; *) exec git "$@";; esac',
			'for arg in "$@"; do remote="$arg"; case "$arg" in *.git) break;; esac; done',
			`echo "start $(basename "$remote")" >> "${log}"`,
			'git "$@"; status=$?',
			// The first optional checkout's fetch ends last, so only an ordered recording lists it first.
			'case "$remote" in *second.git) sleep 1.5;; *) sleep 0.5;; esac',
			`echo "end $(basename "$remote")" >> "${log}"`,
			'exit "$status"',
			"",
		].join("\n"),
	);
	chmodSync(shim, 0o755);
	return { path: shim, env: sandbox.executable.env };
}

describe("optional checkouts restore concurrently (#4748)", () => {
	test.skipIf(process.platform === "win32")(
		"two optional restores run concurrently: both start before either ends, and are recorded in order (#4748)",
		async () => {
			const { clone: first } = await sandbox.remoteWithClone("first");
			const { clone: second } = await sandbox.remoteWithClone("second");
			const { clone: third } = await sandbox.remoteWithClone("third");
			const manager = await sessionWithOptionalCheckouts(first, [second, third]);
			renameSync(second, sandbox.path("second-gone"));
			renameSync(third, sandbox.path("third-gone"));
			const log = sandbox.path("fetches.log");
			const git = gitLoggingFetches(log);
			setWorktreeSnapshotGit(async () => git);

			const prepared = await prepareSessionResume(manager, {
				entryPoint: "cli",
				launchCwd: first,
				settings,
				storeDir: sandbox.path("host"),
				blueprints: "skip",
			});

			assert.equal(prepared.status, "ready");
			const events = readFileSync(log, "utf8").trim().split("\n");
			const firstEnd = events.findIndex((event) => event.startsWith("end "));
			assert.ok(events.indexOf("start second.git") < firstEnd, events.join(", "));
			assert.ok(events.indexOf("start third.git") < firstEnd, events.join(", "));
			assert.deepEqual(
				manager.getWorktreeRootMappings().map((mapping) => mapping.from),
				[second, third],
			);
			for (const mapping of manager.getWorktreeRootMappings()) {
				assert.equal(readFileSync(join(mapping.to, "README.md"), "utf8"), `edited ${mapping.from}\n`);
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"a resume cancelled while optional checkouts restore concurrently rejects with the cancellation (#4748)",
		async () => {
			const { clone: first } = await sandbox.remoteWithClone("first");
			const { clone: second } = await sandbox.remoteWithClone("second");
			const { clone: third } = await sandbox.remoteWithClone("third");
			const manager = await sessionWithOptionalCheckouts(first, [second, third]);
			renameSync(second, sandbox.path("second-gone"));
			renameSync(third, sandbox.path("third-gone"));
			const log = sandbox.path("fetches.log");
			const git = gitLoggingFetches(log);
			setWorktreeSnapshotGit(async () => git);
			const controller = new AbortController();
			const reason = new Error("cancelled during the optional restores");
			const watch = setInterval(() => {
				if (existsSync(log) && readFileSync(log, "utf8").includes("start third.git")) controller.abort(reason);
			}, 20);

			try {
				await assert.rejects(
					prepareSessionResume(manager, {
						entryPoint: "cli",
						launchCwd: first,
						settings,
						storeDir: sandbox.path("host"),
						blueprints: "skip",
						signal: controller.signal,
					}),
					(error: unknown) => error === reason,
				);
			} finally {
				clearInterval(watch);
			}
		},
	);

	test("of two optional checkouts, one with a missing blob gets today's notice and the other is restored (#4748)", async () => {
		const { clone: first } = await sandbox.remoteWithClone("first");
		const { clone: second } = await sandbox.remoteWithClone("second");
		const { clone: third } = await sandbox.remoteWithClone("third");
		const manager = await sessionWithOptionalCheckouts(first, [second, third]);
		const broken = manager.getLatestWorktreeSnapshots().get(second)!;
		await loseSnapshotBlobs(manager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore, [
			broken.chain.at(-1)!.patch!,
		]);
		renameSync(second, sandbox.path("second-gone"));
		renameSync(third, sandbox.path("third-gone"));

		const prepared = await prepareSessionResume(manager, {
			entryPoint: "cli",
			launchCwd: first,
			settings,
			storeDir: sandbox.path("host"),
			blueprints: "skip",
		});

		assert.equal(prepared.status, "ready");
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => mapping.from),
			[second, third],
		);
		assert.equal(mappings[0]!.degraded?.stage, "partial-changes");
		assert.equal(readFileSync(join(mappings[0]!.to, "README.md"), "utf8"), "hello\n");
		assert.equal(mappings[1]!.degraded, undefined);
		assert.equal(readFileSync(join(mappings[1]!.to, "README.md"), "utf8"), `edited ${third}\n`);
		const notices = prepared.status === "ready" ? prepared.notices.map((notice) => notice.message) : [];
		assert.equal(notices.filter((message) => message.includes(broken.id.slice(0, 12))).length, 1, notices.join("\n"));
	});
});
