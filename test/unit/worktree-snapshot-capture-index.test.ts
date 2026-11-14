import assert from "node:assert/strict";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { runGit, setWorktreeSnapshotGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureIndexPath,
	defaultWorktreeSnapshotStoreDir,
} from "../../packages/coding-agent/src/core/worktree-snapshot/paths.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

/** The benchmark writes several thousand files and captures them twice. */
const BENCHMARK_TIMEOUT_MS = 120_000;

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	vi.unstubAllEnvs();
	sandbox.dispose();
});

async function captureOf(dir: string, maxFileBytes?: number) {
	const result: WorktreeSnapshotCapture = await captureWorktreeSnapshot(dir, { settings: { maxFileBytes } });
	if (result.status !== "captured") throw new Error(`unexpected ${result.status}`);
	return result.snapshot;
}

async function treeOf(dir: string): Promise<string> {
	return (await captureOf(dir)).tree;
}

/** Asserts the last capture of `clone` went through its private index: one that cannot be used is removed. */
async function assertUsedPrivateIndex(clone: string): Promise<void> {
	const index = await privateIndexOf(clone);
	assert.ok(existsSync(index), "the capture kept its private index");
	const listed = await runGit(["ls-files"], { cwd: clone, env: { GIT_INDEX_FILE: index }, allowExitCodes: [128] });
	assert.equal(listed.exitCode, 0, "the private index is a readable Git index");
}

/** The tree a capture records through the private index. */
async function treeThroughPrivateIndex(clone: string): Promise<string> {
	const tree = await treeOf(clone);
	await assertUsedPrivateIndex(clone);
	return tree;
}

async function privateIndexOf(clone: string): Promise<string> {
	const gitDir = await sandbox.git(clone, "rev-parse", "--absolute-git-dir");
	return captureIndexPath(defaultWorktreeSnapshotStoreDir(), gitDir, clone);
}

/** The tree a capture records when it cannot use its private index: today's copy of the user's index. */
async function treeWithoutPrivateIndex(clone: string): Promise<string> {
	writeFileSync(await privateIndexOf(clone), "not an index");
	return treeOf(clone);
}

async function treeFile(clone: string, tree: string, path: string): Promise<string> {
	return sandbox.git(clone, "cat-file", "-p", `${tree}:${path}`);
}

describe("capture keeps a persistent private index (#4748)", () => {
	test("the private index lives under the store, and the user's index is left as it was (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const userIndex = join(clone, ".git", "index");
		const before = { bytes: readFileSync(userIndex), mtimeMs: statSync(userIndex).mtimeMs };

		await treeThroughPrivateIndex(clone);

		assert.deepEqual(readFileSync(userIndex), before.bytes);
		assert.equal(statSync(userIndex).mtimeMs, before.mtimeMs);
		assert.deepEqual(
			readdirSync(join(defaultWorktreeSnapshotStoreDir(), "capture-index")).filter((name) => name.endsWith(".tmp")),
			[],
			"no working copy is left behind",
		);
	});

	test("concurrent captures of one checkout take turns with its index and record the same tree (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
		sandbox.write(join(clone, "a.txt"), "changed\n");
		sandbox.write(join(clone, "new.txt"), "new\n");

		const trees = await Promise.all([treeOf(clone), treeOf(clone), treeOf(clone)]);

		assert.deepEqual(new Set(trees).size, 1);
		assert.equal(await treeFile(clone, trees[0]!, "new.txt"), "new");
		assert.deepEqual(
			readdirSync(join(defaultWorktreeSnapshotStoreDir(), "capture-index")).filter((name) => name.endsWith(".tmp")),
			[],
		);
		assert.equal(await treeWithoutPrivateIndex(clone), trees[0]);
	});

	test("an edit in the same second that keeps the size and time is still recorded (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "aaaa\n" });
		const file = join(clone, "a.txt");
		// A time ahead of every index write makes the entry racily clean, as an edit in the second of a capture is.
		const racy = Math.ceil(Date.now() / 1000) + 30;
		utimesSync(file, racy, racy);
		await treeOf(clone);

		writeFileSync(file, "bbbb\n");
		utimesSync(file, racy, racy);
		const tree = await treeThroughPrivateIndex(clone);

		assert.equal(await treeFile(clone, tree, "a.txt"), "bbbb");
		assert.equal(await treeWithoutPrivateIndex(clone), tree);
	});

	test("a file force-added despite an ignore rule is recorded, and an ignored unstaged one is not (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitignore": "build/\n*.log\n", "a.txt": "a\n" });
		sandbox.write(join(clone, "staged.txt"), "staged\n");
		await sandbox.git(clone, "add", "staged.txt");
		await treeThroughPrivateIndex(clone);
		sandbox.write(join(clone, "build", "kept.txt"), "kept\n");
		sandbox.write(join(clone, "forced.log"), "forced\n");
		sandbox.write(join(clone, "left.log"), "left\n");
		await sandbox.git(clone, "add", "-f", "build/kept.txt", "forced.log");

		const tree = await treeThroughPrivateIndex(clone);

		const paths = (await sandbox.git(clone, "ls-tree", "-r", "--name-only", tree)).split("\n");
		assert.deepEqual(paths, [".gitignore", "a.txt", "build/kept.txt", "forced.log", "staged.txt"]);
		assert.equal(await treeWithoutPrivateIndex(clone), tree);
	});

	test("a moved HEAD is recorded against the new commit, without the old one's changes (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n", "b.txt": "b\n" });
		sandbox.write(join(clone, "a.txt"), "two\n");
		await treeOf(clone);
		await sandbox.commitAll(clone, "two");
		await sandbox.git(clone, "checkout", "-q", "-b", "side", "HEAD~1");
		sandbox.write(join(clone, "b.txt"), "side\n");

		const tree = await treeThroughPrivateIndex(clone);

		assert.equal(await treeFile(clone, tree, "a.txt"), "one");
		assert.equal(await treeFile(clone, tree, "b.txt"), "side");
		assert.equal(await treeWithoutPrivateIndex(clone), tree);
	});

	test("files rewritten with the same content, as a copy does, record HEAD's tree (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n", "dir/b.txt": "b\n" });
		await treeOf(clone);
		const later = Math.floor(Date.now() / 1000) - 5;
		for (const path of ["a.txt", "dir/b.txt"]) {
			writeFileSync(join(clone, path), readFileSync(join(clone, path)));
			utimesSync(join(clone, path), later, later);
		}

		const tree = await treeThroughPrivateIndex(clone);

		assert.equal(tree, await sandbox.git(clone, "rev-parse", "HEAD^{tree}"));
		assert.equal(await treeWithoutPrivateIndex(clone), tree);
	});

	test("each checkout gets a private index of its own, named from its Git directory and root (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("one");
		const { clone: other } = await sandbox.remoteWithClone("two");
		await treeThroughPrivateIndex(clone);
		await treeThroughPrivateIndex(other);

		const names = [await privateIndexOf(clone), await privateIndexOf(other)].map((path) => path.split(/[\\/]/).pop());
		assert.notEqual(names[0], names[1]);
		for (const name of names) assert.match(name!, /^[0-9a-f]{24}$/);
	});

	test("a checkout without an index of its own is captured through the private index (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
		rmSync(join(clone, ".git", "index"));

		const tree = await treeThroughPrivateIndex(clone);

		assert.equal(tree, await sandbox.git(clone, "rev-parse", "HEAD^{tree}"));
	});

	test("a private index removed behind its record is rebuilt by the next capture (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
		sandbox.write(join(clone, "a.txt"), "changed\n");
		const expected = await treeThroughPrivateIndex(clone);
		rmSync(await privateIndexOf(clone));

		assert.equal(await treeThroughPrivateIndex(clone), expected);
	});

	test("an unchanged tracked file over the size cap whose times changed is not reported as left out (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "big.txt": "0123456789\n" });
		const file = join(clone, "big.txt");
		const later = Math.floor(Date.now() / 1000) - 5;
		writeFileSync(file, readFileSync(file));
		utimesSync(file, later, later);

		const snapshot = await captureOf(clone, 4);

		assert.deepEqual(snapshot.omitted, []);
		assert.equal(snapshot.tree, await sandbox.git(clone, "rev-parse", "HEAD^{tree}"));
	});
});

describe("a private index that cannot be used falls back to today's capture (#4748)", () => {
	for (const [name, damage] of [
		["corrupt", (file: string) => writeFileSync(file, Buffer.alloc(statSync(file).size, 0x5a))],
		["truncated", (file: string) => truncateSync(file, Math.floor(statSync(file).size / 2))],
		["locked", (file: string) => writeFileSync(`${file}.${process.pid}.tmp.lock`, "")],
	] as const) {
		test(`a ${name} private index records the same tree and is rebuilt afterwards (#4748)`, async () => {
			const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n", "b.txt": "b\n" });
			sandbox.write(join(clone, "a.txt"), "changed\n");
			sandbox.write(join(clone, "new.txt"), "new\n");
			const expected = await treeThroughPrivateIndex(clone);
			const index = await privateIndexOf(clone);
			damage(index);

			assert.equal(await treeOf(clone), expected);
			assert.equal(
				await treeThroughPrivateIndex(clone),
				expected,
				"the next capture writes a usable private index again",
			);
			assert.ok(!existsSync(`${index}.${process.pid}.tmp.lock`));
			const user = await sandbox.git(clone, "status", "--porcelain");
			assert.equal(user, " M a.txt\n?? new.txt", "the user's index is left as it was");
		});
	}

	for (const [name, record] of [
		["of another version", JSON.stringify({ version: 0 })],
		["with an unreadable record", "not json"],
	] as const) {
		test(`an index ${name} is reseeded from the user's index and records the same tree (#4748)`, async () => {
			const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
			sandbox.write(join(clone, "a.txt"), "changed\n");
			const expected = await treeThroughPrivateIndex(clone);
			const index = await privateIndexOf(clone);
			writeFileSync(`${index}.json`, record);

			assert.equal(await treeThroughPrivateIndex(clone), expected);
			assert.equal(JSON.parse(readFileSync(`${index}.json`, "utf8")).version, 1);
		});
	}
});

describe("where the private index may not go (#4748)", () => {
	test("a store inside the checkout is not captured: the capture keeps no private index there (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(clone, "agent-home"));
		sandbox.write(join(clone, "a.txt"), "changed\n");

		const first = await treeOf(clone);
		const second = await treeOf(clone);

		assert.equal(second, first);
		const paths = (await sandbox.git(clone, "ls-tree", "-r", "--name-only", second)).split("\n");
		assert.deepEqual(paths, ["a.txt"]);
		assert.equal(existsSync(join(clone, "agent-home")), false);
	});

	test("a cancelled capture leaves no working copy of the private index behind (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
		await treeThroughPrivateIndex(clone);
		sandbox.write(join(clone, "a.txt"), "changed\n");
		const controller = new AbortController();
		let invocations = 0;
		const executable = sandbox.executable;
		const restore = setWorktreeSnapshotGit(async () => {
			// After locating the checkout and its index: the working copy of the private index exists by then.
			if (++invocations === 5) controller.abort(new Error("cancelled by the user"));
			return executable;
		});
		try {
			await assert.rejects(
				captureWorktreeSnapshot(clone, { signal: controller.signal }),
				(error: unknown) => error === controller.signal.reason,
			);
		} finally {
			setWorktreeSnapshotGit(restore);
		}

		assert.deepEqual(
			readdirSync(join(defaultWorktreeSnapshotStoreDir(), "capture-index")).filter(
				(name) => name.endsWith(".tmp") || name.endsWith(".lock"),
			),
			[],
		);
		assert.equal(await treeThroughPrivateIndex(clone), await treeWithoutPrivateIndex(clone));
	});
});

describe("capture cost with a persistent private index (#4748)", () => {
	/** A clone of `files` whose entries are as new as its index, as after a fresh clone: Git must read each file. */
	async function racilyCleanClone(name: string, files: Record<string, string>): Promise<string> {
		const { clone } = await sandbox.remoteWithClone(name, files);
		const instant = Math.floor(Date.now() / 1000) - 60;
		for (const path of Object.keys(files)) utimesSync(join(clone, path), instant, instant);
		await sandbox.git(clone, "update-index", "-q", "--refresh");
		utimesSync(join(clone, ".git", "index"), instant, instant);
		return clone;
	}

	/** Median times of a capture that seeds the private index of `clone` and of the capture after it, three of each. */
	async function captureTimes(clone: string) {
		const index = await privateIndexOf(clone);
		const timed = async () => {
			const started = performance.now();
			const tree = await treeOf(clone);
			return { tree, ms: performance.now() - started };
		};
		const seeding: number[] = [];
		const reusing: number[] = [];
		const trees = new Set<string>();
		for (let round = 0; round < 3; round++) {
			rmSync(index, { force: true });
			rmSync(`${index}.json`, { force: true });
			const first = await timed();
			const second = await timed();
			seeding.push(first.ms);
			reusing.push(second.ms);
			trees.add(first.tree).add(second.tree);
		}
		assert.equal(trees.size, 1, "every capture records the same tree");
		const median = (values: number[]) => values.sort((left, right) => left - right)[1]!;
		return { seeded: median(seeding), reused: median(reusing) };
	}

	test(
		"on a racily clean 3,000-file checkout a capture with its private index costs at most half one that seeds it (#4748)",
		async () => {
			const files: Record<string, string> = {};
			const body = "x".repeat(32 * 1024);
			for (let index = 0; index < 3000; index++) files[`d${index % 30}/f${index}.txt`] = `${index}\n${body}`;
			const large = await racilyCleanClone("large", files);
			const small = await racilyCleanClone("small", { "a.txt": "a\n" });

			const { seeded, reused } = await captureTimes(large);
			// What every capture costs whatever the checkout's size (starting Git about twenty times), measured here so a
			// host where starting a process is slow, as on Windows, compares only the part the private index changes.
			const fixed = (await captureTimes(small)).reused;

			assert.ok(
				reused - fixed <= (seeded - fixed) * 0.5,
				`with its private index ${reused.toFixed(0)} ms, seeding it ${seeded.toFixed(0)} ms, a one-file capture ${fixed.toFixed(0)} ms: expected at most half beyond the one-file capture`,
			);
		},
		BENCHMARK_TIMEOUT_MS,
	);
});
