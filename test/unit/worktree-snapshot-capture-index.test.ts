import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
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
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { runGit, setWorktreeSnapshotGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureIndexPath,
	defaultWorktreeSnapshotStoreDir,
} from "../../packages/coding-agent/src/core/worktree-snapshot/paths.ts";
import { bunExecutable, moduleDir, readStreamText, spawnProcess } from "../helpers/runtime.js";
import { GitSandbox, gitConfigPath } from "../helpers/worktree-snapshot.js";

/** The benchmark writes several thousand files and captures them four times, Git cleaning each file it reads. */
const BENCHMARK_TIMEOUT_MS = 120_000;
const CHECKOUT_FILES = 3000;
const COUNTING_CLEAN_FILTER = join(moduleDir(import.meta.url), "..", "fixtures", "git-counting-clean-filter.mjs");
/** The cross-process test starts real Bun processes, each loading the capture module before it captures. */
const CHILD_PROCESS_TIMEOUT_MS = 90_000;
const CAPTURE_PROCESSES = 4;
const CAPTURES_PER_PROCESS = 5;
const CAPTURE_CHILD = join(moduleDir(import.meta.url), "..", "fixtures", "worktree-snapshot-capture-child.ts");

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox(
		`[filter "count"]\n\tprocess = \\"${gitConfigPath(process.execPath)}\\" \\"${gitConfigPath(COUNTING_CLEAN_FILTER)}\\"\n`,
	);
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

	test("a record that cannot be replaced leaves no temporary record behind (#4847)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
		sandbox.write(join(clone, "a.txt"), "changed\n");
		const expected = await treeThroughPrivateIndex(clone);
		const index = await privateIndexOf(clone);
		// A directory where the record goes refuses the rename on every platform, as a record another process holds
		// open does on Windows.
		rmSync(`${index}.json`);
		sandbox.write(join(`${index}.json`, "held"), "");

		assert.equal(await treeOf(clone), expected);
		assert.deepEqual(
			readdirSync(join(defaultWorktreeSnapshotStoreDir(), "capture-index")).filter((name) => name.endsWith(".tmp")),
			[],
		);
	});

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

describe("the private index and its record stay consistent (#4847)", () => {
	/**
	 * A checkout whose `a.txt` was rewritten with the same size and time while Git ignores ctime, then staged again:
	 * only the user's index knows its new content, so a private index from before is stale.
	 */
	async function sameStatRewriteStaged(clone: string): Promise<void> {
		const file = join(clone, "a.txt");
		const { mtime } = statSync(file);
		writeFileSync(file, "bbbb\n");
		utimesSync(file, mtime, mtime);
		await sandbox.git(clone, "rm", "-q", "--cached", "a.txt");
		await sandbox.git(clone, "add", "a.txt");
	}

	async function trustlessCtimeClone(): Promise<string> {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "aaaa\n" });
		await sandbox.git(clone, "config", "core.trustctime", "false");
		const past = Math.floor(Date.now() / 1000) - 60;
		utimesSync(join(clone, "a.txt"), past, past);
		return clone;
	}

	test("a private index a crash left behind its newer record is rebuilt from the user's index (#4847)", async () => {
		const clone = await trustlessCtimeClone();
		await treeThroughPrivateIndex(clone);
		const index = await privateIndexOf(clone);
		const before = readFileSync(index);
		await sameStatRewriteStaged(clone);
		await treeOf(clone);
		// The record moved on to the user's new index; the index file did not.
		writeFileSync(index, before);

		const tree = await treeThroughPrivateIndex(clone);

		assert.equal(await treeFile(clone, tree, "a.txt"), "bbbb");
	});

	test("a record a crash left behind its newer private index is rebuilt from the user's index (#4847)", async () => {
		const clone = await trustlessCtimeClone();
		await treeThroughPrivateIndex(clone);
		const index = await privateIndexOf(clone);
		await sameStatRewriteStaged(clone);
		const record = readFileSync(`${index}.json`);
		await treeOf(clone);
		// The index file moved on; its record still describes the one before.
		writeFileSync(`${index}.json`, record);

		const tree = await treeThroughPrivateIndex(clone);

		assert.equal(await treeFile(clone, tree, "a.txt"), "bbbb");
	});

	test(
		"captures from several processes at once record the right tree and leave a truthful record (#4847)",
		async () => {
			const clone = await trustlessCtimeClone();
			sandbox.write(join(clone, "new.txt"), "new\n");
			sandbox.write(join(clone, "staged.txt"), "staged\n");
			await sandbox.git(clone, "add", "staged.txt");
			await treeOf(clone);
			// Removes the private index and its record, so the processes also race to seed it.
			const expected = await treeWithoutPrivateIndex(clone);

			const children = Array.from({ length: CAPTURE_PROCESSES }, () =>
				spawnProcess([bunExecutable(), CAPTURE_CHILD, clone, String(CAPTURES_PER_PROCESS)], {
					env: { ...process.env, ...sandbox.executable.env, ATOMIC_CODING_AGENT_DIR: getAgentDir() },
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			const outputs = await Promise.all(
				children.map(async (child) => {
					const [stdout, stderr, code] = await Promise.all([
						readStreamText(child.stdout),
						readStreamText(child.stderr),
						child.exited,
					]);
					assert.equal(code, 0, stderr);
					return stdout.trim().split("\n");
				}),
			);

			assert.deepEqual(outputs, Array(CAPTURE_PROCESSES).fill(Array(CAPTURES_PER_PROCESS).fill(expected)));
			assert.deepEqual(
				readdirSync(join(defaultWorktreeSnapshotStoreDir(), "capture-index")).filter((name) =>
					name.endsWith(".tmp"),
				),
				[],
			);
			await sameStatRewriteStaged(clone);
			const tree = await treeThroughPrivateIndex(clone);
			assert.equal(await treeFile(clone, tree, "a.txt"), "bbbb");
			assert.equal(await treeFile(clone, tree, "new.txt"), "new");
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	test("after a crash between the two steps, a file unstaged with git rm --cached is not recorded (#4847)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { ".gitignore": "*.log\n", "a.txt": "a\n" });
		sandbox.write(join(clone, "secret.log"), "secret\n");
		await sandbox.git(clone, "add", "-f", "secret.log");
		await treeThroughPrivateIndex(clone);
		const index = await privateIndexOf(clone);
		const before = readFileSync(index);
		await sandbox.git(clone, "rm", "-q", "--cached", "secret.log");
		await treeOf(clone);
		writeFileSync(index, before);

		const tree = await treeThroughPrivateIndex(clone);

		const paths = (await sandbox.git(clone, "ls-tree", "-r", "--name-only", tree)).split("\n");
		assert.deepEqual(paths, [".gitignore", "a.txt"]);
		assert.equal(await treeWithoutPrivateIndex(clone), tree);
	});
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

	test("a store whose capture-index directory cannot be searched still captures, without a private index (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
		sandbox.write(join(clone, "a.txt"), "changed\n");
		const directory = join(defaultWorktreeSnapshotStoreDir(), "capture-index");
		mkdirSync(directory, { recursive: true });
		chmodSync(directory, 0);
		try {
			const tree = await treeOf(clone);

			assert.equal(await treeFile(clone, tree, "a.txt"), "changed");
		} finally {
			chmodSync(directory, 0o755);
		}
	});

	test("a cancelled capture leaves no working copy of the private index behind (#4748)", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "a\n" });
		await treeThroughPrivateIndex(clone);
		sandbox.write(join(clone, "a.txt"), "changed\n");
		const controller = new AbortController();
		let invocations = 0;
		const executable = sandbox.executable;
		const restore = setWorktreeSnapshotGit(async () => {
			// The third, `update-index`, after locating the checkout and listing its files: the working copy of the
			// private index exists by then.
			if (++invocations === 3) controller.abort(new Error("cancelled by the user"));
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

describe("capture cost with a persistent private index (#4748, #5343)", () => {
	/** A clone of `files` whose entries are as new as its index, as after a fresh clone: Git must read each file. */
	async function racilyCleanClone(name: string, files: Record<string, string>): Promise<string> {
		const { clone } = await sandbox.remoteWithClone(name, files);
		const instant = Math.floor(Date.now() / 1000) - 60;
		for (const path of Object.keys(files)) utimesSync(join(clone, path), instant, instant);
		await sandbox.git(clone, "update-index", "-q", "--refresh");
		utimesSync(join(clone, ".git", "index"), instant, instant);
		return clone;
	}

	async function filesReadByCapture(clone: string): Promise<{ tree: string; read: number }> {
		const counted = sandbox.path(`clean-${Date.now()}-${Math.random()}.txt`);
		const executable = {
			...sandbox.executable,
			env: { ...sandbox.executable.env, ATOMIC_TEST_CLEAN_COUNT: counted },
		};
		setWorktreeSnapshotGit(async () => executable);
		try {
			const tree = await treeOf(clone);
			return {
				tree,
				read: existsSync(counted) ? readFileSync(counted, "utf8").split("\n").filter(Boolean).length : 0,
			};
		} finally {
			setWorktreeSnapshotGit(async () => sandbox.executable);
		}
	}

	test(
		"on a racily clean 3,000-file checkout a capture with its private index reads at most half the files one that seeds it reads (#4748, #5343)",
		async () => {
			const files: Record<string, string> = { ".gitattributes": "*.txt filter=count\n" };
			const body = "x".repeat(1024);
			for (let index = 0; index < CHECKOUT_FILES; index++)
				files[`d${index % 30}/f${index}.txt`] = `${index}\n${body}`;
			const clone = await racilyCleanClone("large", files);
			const index = await privateIndexOf(clone);
			const reads: { seeded: number; reused: number }[] = [];
			const trees = new Set<string>();
			for (let round = 0; round < 2; round++) {
				rmSync(index, { force: true });
				rmSync(`${index}.json`, { force: true });
				const seeding = await filesReadByCapture(clone);
				const reusing = await filesReadByCapture(clone);
				reads.push({ seeded: seeding.read, reused: reusing.read });
				trees.add(seeding.tree).add(reusing.tree);
			}
			await assertUsedPrivateIndex(clone);
			assert.equal(trees.size, 1, "every capture records the same tree");
			for (const { seeded, reused } of reads) {
				assert.ok(seeded >= CHECKOUT_FILES, `seeding read ${seeded} of the ${CHECKOUT_FILES} racily clean files`);
				assert.ok(reused <= seeded * 0.5, `with its private index ${reused} files read, seeding it ${seeded}`);
			}
		},
		BENCHMARK_TIMEOUT_MS,
	);
});
