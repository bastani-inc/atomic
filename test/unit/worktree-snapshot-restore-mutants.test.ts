import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { FilesystemFault } from "../helpers/worktree-snapshot-faults.js";

/** Filesystem calls that fail for one path, as a symbolic link that loops makes them. */
const filesystem = vi.hoisted(() => ({ faults: [] as FilesystemFault[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const { withFilesystemFaults } = await import("../helpers/worktree-snapshot-faults.js");
	return withFilesystemFaults(
		await importOriginal<typeof import("node:fs/promises")>(),
		"promises",
		["stat"],
		() => filesystem.faults,
	);
});

/** Every Git process the code under test starts, and an optional hook that can redirect one or schedule a fault. */
const spawned = vi.hoisted(() => ({
	calls: [] as (readonly string[])[],
	closed: [] as (readonly string[])[],
	hook: undefined as
		| undefined
		| ((args: readonly string[]) => { readonly command?: string; readonly args?: readonly string[] } | undefined),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: readonly string[], options: object) => {
			const override = spawned.hook?.(args);
			const child = (actual.spawn as (...parameters: unknown[]) => import("node:child_process").ChildProcess)(
				override?.command ?? command,
				override?.args ?? args,
				options,
			);
			spawned.calls.push(args);
			child.on("close", () => spawned.closed.push(args));
			return child;
		},
	};
});

import { runGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureWorktreeSnapshot,
	isGitUnavailableError,
	isWorkspaceGitError,
	isWorkspaceRestoreError,
	isWorkspaceSnapshotError,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	restoreWorktree,
	restoreWorktreeSnapshot,
	type SnapshotBlobStore,
	snapshotBlob,
	verifyWorktree,
	type WorkspaceBinding,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/index.ts";
import { BELOW_FILE_ERRNO, GitSandbox, lfsPointer, loseSnapshotBlobs } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
	spawned.hook = undefined;
	spawned.calls.length = 0;
	spawned.closed.length = 0;
});
afterEach(() => {
	filesystem.faults.length = 0;
	spawned.hook = undefined;
	sandbox.dispose();
});

/** A Git invocation's arguments past the leading `-c key=value` pairs. */
function command(args: readonly string[]): string[] {
	const rest: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (rest.length === 0 && args[index] === "-c") index++;
		else rest.push(args[index]!);
	}
	return rest;
}
const invocations = (name: string) => spawned.calls.map(command).filter((rest) => rest[0] === name);
/** The repository each `git fetch` since the last reset read from, a remote URL or a bundle file, always after `--`. */
const fetchedFrom = () =>
	invocations("fetch").map((rest) => {
		const separator = rest.indexOf("--");
		assert.ok(separator > 0 && rest.slice(1, separator).every((arg) => arg.startsWith("-")), rest.join(" "));
		return rest[separator + 1]!;
	});
const reset = () => {
	spawned.calls.length = 0;
	spawned.closed.length = 0;
};

/** Makes Git commands matching `matches` fail to start, as if the executable vanished between two commands. */
function vanishWhen(matches: (rest: readonly string[]) => boolean): void {
	const vanished = sandbox.path("vanished-git");
	spawned.hook = (args) => (matches(command(args)) ? { command: vanished } : undefined);
}

/** Aborts `controller` with `reason` as soon as a command matching `matches` has started. */
function abortWhen(controller: AbortController, reason: Error, matches: (rest: readonly string[]) => boolean): void {
	spawned.hook = (args) => {
		if (matches(command(args))) queueMicrotask(() => controller.abort(reason));
		return undefined;
	};
}

async function capture(dir: string, blobs: SnapshotBlobStore, previous?: WorktreeSnapshot): Promise<WorktreeSnapshot> {
	const result: WorktreeSnapshotCapture = await captureWorktreeSnapshot(dir, { blobs, previous });
	assert.equal(result.status, "captured");
	return (result as Extract<WorktreeSnapshotCapture, { status: "captured" }>).snapshot;
}

const bindingOf = (snapshot: WorktreeSnapshot): WorkspaceBinding => ({
	remotes: [...snapshot.remotes],
	head: snapshot.head,
	tree: snapshot.tree,
	envHash: snapshot.envHash,
});

/** Whether the shared store a restore keeps for `remotes` under `storeDir` holds `commit`. */
async function storeHas(storeDir: string, remotes: readonly string[], commit: string): Promise<boolean> {
	const store = join(
		storeDir,
		"repositories",
		`${createHash("sha256").update(remotes.join("\n")).digest("hex").slice(0, 24)}.git`,
	);
	const { exitCode } = await runGit(["--git-dir", store, "cat-file", "-e", `${commit}^{commit}`], {
		cwd: sandbox.root,
		allowExitCodes: [1, 128],
	});
	return exitCode === 0;
}

/** A clone with one unpushed commit, and a pushed side branch whose commit `main` does not reach. */
async function cloneWithSideBranch() {
	const { remote, clone } = await sandbox.remoteWithClone();
	await sandbox.git(clone, "checkout", "-q", "-b", "side");
	sandbox.write(join(clone, "side.txt"), "side\n");
	const side = await sandbox.commitAll(clone, "side");
	await sandbox.git(clone, "push", "-q", "origin", "side");
	await sandbox.git(clone, "checkout", "-q", "main");
	sandbox.write(join(clone, "feature.txt"), "feature\n");
	await sandbox.commitAll(clone, "unpushed");
	return { remote, clone, side };
}

/** `snapshot` with its bundle replaced by `bytes`, stored in `blobs` under their own hash. */
async function withBundleBytes(
	snapshot: WorktreeSnapshot,
	blobs: SnapshotBlobStore,
	bytes: Uint8Array,
): Promise<WorktreeSnapshot> {
	const blob = snapshotBlob(bytes);
	await blobs.putBlobs([blob]);
	return { ...snapshot, bundle: { blob: blob.hash, bytes: bytes.byteLength, commits: [snapshot.head] } };
}

describe("finding the head", () => {
	test("a later remote is fetched from only while the head is still missing", async () => {
		const { remote, clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const bogus = sandbox.path("bogus.git");
		reset();
		await restoreWorktree({ ...snapshot, remotes: [remote, bogus] }, { blobs, storeDir: sandbox.path("host-1") });
		assert.deepEqual(fetchedFrom(), [remote]);
		reset();
		await restoreWorktree({ ...snapshot, remotes: [bogus, remote] }, { blobs, storeDir: sandbox.path("host-2") });
		assert.deepEqual(fetchedFrom(), [bogus, remote]);
	});

	test("once unpushed commits are pushed, the head comes from the remote and the bundle is not needed", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		await sandbox.commitAll(clone, "unpushed");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.ok(snapshot.bundle);
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		await loseSnapshotBlobs(blobs, [snapshot.bundle.blob]);
		const restored = await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
		assert.equal(readFileSync(join(restored.path, "feature.txt"), "utf8"), "feature\n");
	});

	test("a bundle that unpacks without the head keeps the remote's failure as the cause", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "one.txt"), "1\n");
		await sandbox.commitAll(clone, "one");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.ok(snapshot.bundle);
		sandbox.write(join(clone, "two.txt"), "2\n");
		const outsideBundle = await sandbox.commitAll(clone, "two, never bundled");
		await assert.rejects(
			restoreWorktree({ ...snapshot, head: outsideBundle }, { blobs, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "commits-unavailable");
				assert.equal(error.reason, "not-fetched");
				assert.deepEqual(error.commits, [outsideBundle]);
				assert.ok(isWorkspaceGitError(error.cause));
				assert.equal(error.cause.operation, "fetch");
				assert.equal(error.cause.exitCode, 128);
				return true;
			},
		);
	});

	test("without remotes, a bundle that fails to unpack is the cause", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		await sandbox.commitAll(clone, "unpushed");
		const blobs = new MemorySnapshotBlobStore();
		const captured = await capture(clone, blobs);
		const snapshot = await withBundleBytes(
			{ ...captured, remotes: [] },
			blobs,
			new TextEncoder().encode(`# v2 git bundle\n${captured.head} HEAD\n\nnot a pack`),
		);
		await assert.rejects(restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "commits-unavailable");
			assert.deepEqual(error.remotes, []);
			assert.ok(isWorkspaceGitError(error.cause));
			assert.equal(error.cause.operation, "fetch");
			return true;
		});
	});

	test("an omission other than an over-cap bundle leaves the head reported as not fetched", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot: WorktreeSnapshot = {
			...(await capture(clone, blobs)),
			remotes: [sandbox.path("nowhere.git")],
			omitted: [{ reason: "over-file-cap", path: "huge.bin", bytes: 1 << 30 }],
		};
		await assert.rejects(restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "commits-unavailable");
			assert.equal(error.reason, "not-fetched");
			assert.deepEqual(error.commits, [snapshot.head]);
			return true;
		});
	});
});

describe("reading a bundle's prerequisites", () => {
	const decoy = "d".repeat(40);

	test("only the header, up to its blank line, names prerequisites", async () => {
		const { remote, clone, side } = await cloneWithSideBranch();
		const blobs = new MemorySnapshotBlobStore();
		const captured = await capture(clone, blobs);
		const bytes = new TextEncoder().encode(
			`# v2 git bundle\n-${side} side\n${captured.head} HEAD\n\nPACK\n-${decoy} pack bytes that look like a line\n`,
		);
		const snapshot = await withBundleBytes(captured, blobs, bytes);
		const storeDir = sandbox.path("host");
		reset();
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, storeDir }),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "commits-unavailable",
		);
		assert.ok(await storeHas(storeDir, [remote], side));
		assert.equal(spawned.calls.flat().includes(decoy), false);
	});

	test("a header without a blank line is read to its last byte", async () => {
		const { remote, clone, side } = await cloneWithSideBranch();
		const blobs = new MemorySnapshotBlobStore();
		const captured = await capture(clone, blobs);
		const snapshot = await withBundleBytes(captured, blobs, new TextEncoder().encode(`# v2 git bundle\n-${side}`));
		const storeDir = sandbox.path("host");
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, storeDir }),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "commits-unavailable",
		);
		assert.ok(await storeHas(storeDir, [remote], side));
	});

	test("bytes that open with a blank line have an empty header and name no prerequisites", async () => {
		const { remote, clone, side } = await cloneWithSideBranch();
		const blobs = new MemorySnapshotBlobStore();
		const captured = await capture(clone, blobs);
		const snapshot = await withBundleBytes(captured, blobs, new TextEncoder().encode(`\n\n-${side} side\n`));
		const storeDir = sandbox.path("host");
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, storeDir }),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "commits-unavailable",
		);
		assert.equal(await storeHas(storeDir, [remote], side), false);
	});

	test("a header without a blank line is read no further than 64 KiB", async () => {
		const { remote, clone, side } = await cloneWithSideBranch();
		const blobs = new MemorySnapshotBlobStore();
		const captured = await capture(clone, blobs);
		const filler = "# filler that is not a prerequisite\n".repeat(Math.ceil(65536 / 36));
		const bytes = new TextEncoder().encode(`# v2 git bundle\n-${side} side\n${filler}-${decoy} beyond the limit\n`);
		assert.ok(bytes.byteLength > 65536);
		const snapshot = await withBundleBytes(captured, blobs, bytes);
		const storeDir = sandbox.path("host");
		reset();
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, storeDir }),
			(error: unknown) => isWorkspaceRestoreError(error) && error.code === "commits-unavailable",
		);
		assert.ok(await storeHas(storeDir, [remote], side));
		assert.equal(spawned.calls.flat().includes(decoy), false);
	});
});

describe("failures that are not Git's own propagate unchanged", () => {
	test("Git vanishing during a fetch is reported as unavailable, not as missing commits", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		vanishWhen((rest) => rest[0] === "fetch");
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") }),
			(error: unknown) => isGitUnavailableError(error) && error.code === "not-installed",
		);
	});

	test("Git vanishing while the bundle is unpacked is reported as unavailable", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "feature.txt"), "feature\n");
		await sandbox.commitAll(clone, "unpushed");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.ok(snapshot.bundle);
		vanishWhen((rest) => rest[0] === "fetch" && rest.some((arg) => basename(arg) === "history.bundle"));
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") }),
			(error: unknown) => isGitUnavailableError(error) && error.code === "not-installed",
		);
	});

	test("Git vanishing while LFS objects are pulled is reported as unavailable, and the worktree is removed", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", {
			".gitattributes": "*.bin filter=lfs -text\n",
			"data.bin": lfsPointer("base\n"),
		});
		sandbox.write(join(clone, "data.bin"), lfsPointer("edited\n"));
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		assert.deepEqual(snapshot.filters?.drivers, ["lfs"]);
		const into = sandbox.path("restored");
		vanishWhen((rest) => rest[0] === "lfs");
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, into, storeDir: sandbox.path("host") }),
			(error: unknown) => isGitUnavailableError(error) && error.code === "not-installed",
		);
		assert.equal(existsSync(into), false);
	});

	test("Git vanishing before the restored checkout is verified is reported as unavailable", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const into = sandbox.path("restored");
		vanishWhen((rest) => rest[0] === "rev-parse" && rest.includes("--show-toplevel"));
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, into, storeDir: sandbox.path("host") }),
			(error: unknown) => isGitUnavailableError(error) && error.code === "not-installed",
		);
		assert.equal(existsSync(into), false);
	});

	test("an abort while a delta is applied rejects with the abort reason", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const controller = new AbortController();
		const reason = new Error("stop while applying");
		abortWhen(controller, reason, (rest) => rest[0] === "apply");
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host"), signal: controller.signal }),
			(error: unknown) => error === reason,
		);
	});

	test("verifyWorktree stops with the abort reason while it computes the tree", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const snapshot = await capture(clone, new MemorySnapshotBlobStore());
		sandbox.write(join(clone, "drift.txt"), "drift\n");
		const controller = new AbortController();
		const reason = new Error("stop while hashing");
		abortWhen(controller, reason, (rest) => rest[0] === "write-tree");
		await assert.rejects(
			verifyWorktree(bindingOf(snapshot), clone, { signal: controller.signal }),
			(error: unknown) => error === reason,
		);
	});
});

describe("what a restore leaves behind", () => {
	test("a worktree whose HEAD is not the snapshot's head is rejected even when its tree matches", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const previousHead = await sandbox.git(clone, "rev-parse", "HEAD");
		const blobs = new MemorySnapshotBlobStore();
		// A depth-1 restore fetches only the snapshot's commit (#4748): an earlier restore puts the previous one in the store.
		await restoreWorktree(await capture(clone, blobs), { blobs, storeDir: sandbox.path("host") });
		await sandbox.git(clone, "commit", "-q", "--allow-empty", "-m", "same tree, new commit");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const result = await captureWorktreeSnapshot(clone, { blobs });
		assert.equal(result.status, "captured");
		const snapshot = (result as Extract<WorktreeSnapshotCapture, { status: "captured" }>).snapshot;
		spawned.hook = (args) => {
			const rest = command(args);
			return rest[0] === "worktree" && rest[1] === "add"
				? { args: [...args.slice(0, -1), previousHead] }
				: undefined;
		};
		const into = sandbox.path("restored");
		await assert.rejects(
			restoreWorktree(snapshot, { blobs, into, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "tree-mismatch");
				assert.equal(error.snapshotId, snapshot.id);
				assert.equal(error.expectedTree, snapshot.tree);
				assert.equal(error.actualTree, snapshot.tree);
				return true;
			},
		);
		assert.equal(existsSync(into), false);
	});

	test("the restored index matches the restored files, so Git reports only real changes", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "kept.txt": "kept\n", "edited.txt": "before\n" });
		sandbox.write(join(clone, "edited.txt"), "after\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const restored = await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
		assert.equal(await sandbox.git(restored.path, "diff-files", "--name-only"), "edited.txt");
	});

	test("a restore into the path of a worktree deleted by hand replaces its stale registration (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const storeDir = sandbox.path("host");
		const into = sandbox.path("restored");
		await restoreWorktreeSnapshot(snapshot, { blobs, into, storeDir });
		rmSync(into, { recursive: true, force: true });
		// As a CI cache restores a Git store whose saving job built a worktree at this path.
		assert.equal(await restoreWorktreeSnapshot(snapshot, { blobs, into, storeDir }), into);
		assert.equal(readFileSync(join(into, "x.txt"), "utf8"), "x\n");
		const registered = (await sandbox.git(into, "worktree", "list", "--porcelain"))
			.split("\n")
			.filter((line) => line.startsWith("worktree ") && line.endsWith(basename(into)));
		assert.equal(registered.length, 1);
	});

	test("a default worktree is named from the snapshot id, or a binding's tree, and a random suffix", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const storeDir = sandbox.path("host");
		const restored = await restoreWorktree(snapshot, { blobs, storeDir });
		assert.equal(dirname(restored.path), join(storeDir, "worktrees"));
		assert.match(basename(restored.path), new RegExp(`^${snapshot.id.slice(0, 12)}-[0-9a-f]{8}$`));
		const warm = await restoreWorktree(bindingOf(snapshot), { storeDir });
		assert.match(basename(warm.path), new RegExp(`^${snapshot.tree.slice(0, 12)}-[0-9a-f]{8}$`));
	});

	test("restore errors name the snapshot being restored, and no snapshot for a bare binding", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitattributes": "*.txt filter=mangle\n" });
		sandbox.write(join(clone, "note.txt"), "alpha\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const storeDir = sandbox.path("host");
		await restoreWorktree(snapshot, { blobs, storeDir });
		const occupied = sandbox.path("occupied");
		sandbox.write(join(occupied, "keep.txt"), "keep\n");
		const unsafe = (expected: string | null) => (error: unknown) =>
			isWorkspaceRestoreError(error) && error.code === "unsafe-target" && error.snapshotId === expected;
		await assert.rejects(restoreWorktree(snapshot, { blobs, into: occupied, storeDir }), unsafe(snapshot.id));
		await assert.rejects(restoreWorktree(bindingOf(snapshot), { into: occupied, storeDir }), unsafe(null));
		writeFileSync(
			sandbox.globalConfig,
			`${readFileSync(sandbox.globalConfig, "utf8")}[filter "mangle"]\n\tsmudge = sed s/alpha/omega/\n`,
		);
		const mismatch = (expected: string | null) => (error: unknown) =>
			isWorkspaceRestoreError(error) && error.code === "tree-mismatch" && error.snapshotId === expected;
		await assert.rejects(restoreWorktree(snapshot, { blobs, storeDir }), mismatch(snapshot.id));
		await assert.rejects(restoreWorktree(bindingOf(snapshot), { storeDir }), mismatch(null));
	});
});

describe("one restore at a time per shared store", () => {
	test("a restore that arrives while another holds the store waits, even after an earlier holder has finished", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "one.txt"), "1\n");
		await sandbox.commitAll(clone, "one");
		const stored = new MemorySnapshotBlobStore();
		const first = await capture(clone, stored);
		sandbox.write(join(clone, "two.txt"), "2\n");
		await sandbox.commitAll(clone, "two");
		const second = await capture(clone, stored);
		assert.ok(first.bundle && second.bundle);
		// Each bundle read, which happens while its restore holds the store, waits until the test opens its gate.
		const gates = new Map<string, { entered: boolean; open: () => void; opened: Promise<void> }>();
		for (const hash of [first.bundle.blob, second.bundle.blob]) {
			let open!: () => void;
			const opened = new Promise<void>((resolve) => {
				open = resolve;
			});
			gates.set(hash, { entered: false, open, opened });
		}
		const blobs: SnapshotBlobStore = {
			putBlobs: (entries) => stored.putBlobs(entries),
			refreshBlobs: (hashes) => stored.refreshBlobs(hashes),
			listBlobHashes: () => stored.listBlobHashes(),
			getBlob: async (hash) => {
				const gate = gates.get(hash);
				if (gate) {
					gate.entered = true;
					await gate.opened;
				}
				return stored.getBlob(hash);
			},
		};
		const until = async (condition: () => boolean) => {
			while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
		};
		const firstGate = gates.get(first.bundle.blob)!;
		const secondGate = gates.get(second.bundle.blob)!;
		const storeDir = sandbox.path("host");

		const holder = restoreWorktree(first, { blobs, storeDir });
		await until(() => firstGate.entered);
		const callsWhileFirstHeld = spawned.calls.length;
		const queued = restoreWorktree(second, { blobs, storeDir });
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(
			spawned.calls.slice(callsWhileFirstHeld).map(command),
			[],
			"the queued restore waits for the store",
		);
		firstGate.open();
		await holder;
		await until(() => secondGate.entered);

		reset();
		const events: string[] = [];
		const late = restoreWorktree(first, { blobs, storeDir }).then((restored) => {
			events.push("late restore finished");
			return restored;
		});
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const startedWhileHeld = spawned.calls.map(command);
		events.push("store released");
		secondGate.open();
		await Promise.all([queued, late]);
		assert.deepEqual(startedWhileHeld, []);
		assert.deepEqual(events, ["store released", "late restore finished"]);
	});
});

describe("restore inputs", () => {
	test("a snapshot with patches but no blob store fails as a missing blob", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const snapshot = await capture(clone, new MemorySnapshotBlobStore());
		await assert.rejects(restoreWorktree(snapshot, { storeDir: sandbox.path("host") }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "blob-missing");
			assert.equal(error.role, "patch");
			assert.equal(error.blob, snapshot.chain[0]!.patch);
			return true;
		});
	});

	test("a destination below a regular file is an unreadable path, refused before any Git work", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const storeDir = sandbox.path("host");
		const into = join(clone, "x.txt", "below");
		reset();
		await assert.rejects(restoreWorktree(snapshot, { blobs, into, storeDir }), (error: unknown) => {
			assert.ok(isWorkspaceSnapshotError(error));
			assert.equal(error.code, "unreadable-path");
			assert.equal(error.subject, into);
			assert.equal((error.cause as NodeJS.ErrnoException).code, BELOW_FILE_ERRNO);
			return true;
		});
		assert.deepEqual(spawned.calls, []);
		assert.equal(existsSync(storeDir), false);
	});

	test("a store directory that cannot be created is an unwritable path naming it and the snapshot", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const blobs = new MemorySnapshotBlobStore();
		const snapshot = await capture(clone, blobs);
		const storeDir = sandbox.path("host-is-a-file");
		writeFileSync(storeDir, "not a directory\n");
		const into = sandbox.path("restored");
		reset();
		await assert.rejects(restoreWorktree(snapshot, { blobs, into, storeDir }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "unwritable-path");
			assert.equal(error.target, join(storeDir, "repositories"));
			assert.equal(error.snapshotId, snapshot.id);
			assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOTDIR");
			return true;
		});
		assert.deepEqual(spawned.calls, []);
		await assert.rejects(restoreWorktree(bindingOf(snapshot), { into, storeDir }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "unwritable-path");
			assert.equal(error.snapshotId, null);
			return true;
		});
	});
});

describe("removeRestoredWorktree", () => {
	test("a path that exists but cannot be inspected is not reported as removed", async () => {
		const loop = sandbox.path("loop");
		mkdirSync(loop);
		writeFileSync(join(loop, "keep.txt"), "kept\n");
		filesystem.faults.push({ call: "stat", path: loop, code: "ELOOP" });
		await assert.rejects(removeRestoredWorktree(loop, { storeDir: sandbox.path("host") }), (error: unknown) => {
			assert.ok(isWorkspaceSnapshotError(error));
			assert.equal(error.code, "unreadable-path");
			assert.equal(error.subject, loop);
			assert.equal((error.cause as NodeJS.ErrnoException).code, "ELOOP");
			return true;
		});
		assert.equal(readFileSync(join(loop, "keep.txt"), "utf8"), "kept\n");
	});

	test("a regular file is not a restored worktree and is left alone", async () => {
		const file = sandbox.path("notes.txt");
		writeFileSync(file, "keep\n");
		reset();
		await assert.rejects(removeRestoredWorktree(file, { storeDir: sandbox.path("host") }), (error: unknown) => {
			assert.ok(isWorkspaceRestoreError(error));
			assert.equal(error.code, "unsafe-target");
			assert.equal(error.reason, "not-restored");
			assert.equal(error.target, file);
			return true;
		});
		assert.deepEqual(spawned.calls, []);
		assert.equal(readFileSync(file, "utf8"), "keep\n");
	});

	test("only worktrees of stores inside the storeDir's repositories directory are ours to remove", async () => {
		const { remote } = await sandbox.remoteWithClone();
		const storeDir = sandbox.path("host");
		mkdirSync(storeDir);
		for (const store of [join(storeDir, "stray.git"), join(storeDir, "repositories")]) {
			await sandbox.git(sandbox.root, "clone", "-q", "--bare", remote, store);
			const worktree = sandbox.path(`worktree-of-${basename(store)}`);
			await sandbox.git(sandbox.root, "--git-dir", store, "worktree", "add", "-q", "--detach", worktree, "HEAD");
			await assert.rejects(removeRestoredWorktree(worktree, { storeDir }), (error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "unsafe-target");
				assert.equal(error.reason, "not-restored");
				return true;
			});
			assert.ok(existsSync(join(worktree, "README.md")));
			rmSync(store, { recursive: true, force: true });
		}
	});
});
