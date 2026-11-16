import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { thisProcess } from "../src/core/worktree-snapshot/process-holder.ts";
import { pendingLfsDownload } from "../src/core/worktree-snapshot/restore.ts";

const statHook = vi.hoisted(() => ({
	removeBeforeStat: undefined as string | undefined,
	/** Runs before the next `stat` of `path`, which waits for it. */
	before: undefined as { readonly path: string; readonly run: () => Promise<void> } | undefined,
}));
const readHook = vi.hoisted(() => ({ path: undefined as string | undefined, reads: 0 }));
/** Runs in each write of a mark naming this process once the file written is truncated; the write ends after it. */
const writeHook = vi.hoisted(() => ({ midway: undefined as (() => Promise<void>) | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const namesThisProcess = (data: unknown) => {
		try {
			return JSON.parse(String(data))?.holder?.pid === process.pid;
		} catch {
			return false;
		}
	};
	return {
		...actual,
		stat: (async (...args: Parameters<typeof actual.stat>) => {
			if (statHook.removeBeforeStat !== undefined && String(args[0]) === statHook.removeBeforeStat) {
				const target = statHook.removeBeforeStat;
				statHook.removeBeforeStat = undefined;
				rmSync(target);
			}
			const before = statHook.before;
			if (before !== undefined && String(args[0]) === before.path) {
				statHook.before = undefined;
				await before.run();
			}
			return actual.stat(...args);
		}) as typeof actual.stat,
		readFile: (async (...args: Parameters<typeof actual.readFile>) => {
			if (readHook.path !== undefined && String(args[0]) === readHook.path) readHook.reads++;
			return actual.readFile(...args);
		}) as typeof actual.readFile,
		writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
			const midway = writeHook.midway;
			if (midway !== undefined && namesThisProcess(args[1])) {
				// A write truncates the file before it writes the data: until then, the file is empty.
				await actual.writeFile(args[0], "");
				await midway();
			}
			return actual.writeFile(...args);
		}) as typeof actual.writeFile,
	};
});

/** A promise and the function that resolves it. */
function signal(): { readonly reached: Promise<void>; readonly reach: () => void } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	return { reached, reach };
}

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	statHook.removeBeforeStat = undefined;
	statHook.before = undefined;
	readHook.path = undefined;
	writeHook.midway = undefined;
	sandbox.dispose();
});

/** A clone with one commit: its HEAD, its tree, and where a pending mark and Git's locks go in its Git directory. */
async function checkout() {
	const { clone, remote } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const gitPath = (name: string) => sandbox.git(clone, "rev-parse", "--path-format=absolute", "--git-path", name);
	return {
		clone,
		remote,
		head: await sandbox.git(clone, "rev-parse", "HEAD"),
		tree: await sandbox.git(clone, "rev-parse", "HEAD^{tree}"),
		mark: await gitPath("atomic-lfs-pending.json"),
		locks: [await gitPath("HEAD.lock"), await gitPath("index.lock")],
	};
}

/** The id of a process that has exited. */
function exitedPid(): number {
	const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
		encoding: "utf8",
	});
	return Number(exited.stdout);
}

const CHANGED = /changed since, so it was not repeated; run `git lfs pull` in it/;

describe("an LFS download an interrupted resume left pending (#5099)", () => {
	test("a worktree without a pending mark has nothing to finish (#5099)", async () => {
		const { clone } = await checkout();
		assert.equal(await pendingLfsDownload(clone), undefined);
	});

	test("a mark whose process is gone has its locks removed and its download finished, which clears it (#5099)", async () => {
		const { clone, remote, head, tree, mark, locks } = await checkout();
		const holder = { ...(await thisProcess()), pid: exitedPid() };
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote], holder }));
		for (const lock of locks) writeFileSync(lock, "");

		const pull = await pendingLfsDownload(clone);
		assert.ok(pull, "the download is finished");
		assert.deepEqual(await pull(), []);
		assert.deepEqual(
			locks.map((lock) => existsSync(lock)),
			[false, false],
		);
		assert.equal(existsSync(mark), false, "nothing is pending once every LFS file has its content");
		assert.equal(await sandbox.git(clone, "rev-parse", "HEAD"), head);
	});

	test("a mark of this process, which no longer downloads, counts as stopped (#5099)", async () => {
		const { clone, remote, head, tree, mark, locks } = await checkout();
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote], holder: await thisProcess() }));
		writeFileSync(locks[1]!, "");
		await (await pendingLfsDownload(clone))?.();
		assert.equal(existsSync(locks[1]!), false);
	});

	test("a mark that names no process leaves Git's locks alone: they are not its download's (#5099)", async () => {
		const { clone, remote, head, tree, mark, locks } = await checkout();
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote] }));
		writeFileSync(locks[1]!, "");
		const pull = await pendingLfsDownload(clone);
		await assert.rejects(pull!(), /index\.lock/);
		assert.equal(existsSync(locks[1]!), true);
	});

	test("a download another running process holds is waited for, and done once that process ends it (#5099)", async () => {
		const { clone, remote, head, tree, mark } = await checkout();
		const parent = { host: (await thisProcess()).host, pid: process.ppid };
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote], holder: parent }));
		const pull = await pendingLfsDownload(clone);
		assert.ok(pull);
		let done = false;
		const waiting = pull().then((pointers) => {
			done = true;
			return pointers;
		});
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal(done, false, "it waits while that process downloads");
		rmSync(mark);
		assert.deepEqual(await waiting, []);
	});

	test("a mark removed right after it is read and before its holder is checked finishes cleanly (#5099)", async () => {
		const { clone, remote, head, tree, mark } = await checkout();
		const parent = { host: (await thisProcess()).host, pid: process.ppid };
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote], holder: parent }));
		const pull = await pendingLfsDownload(clone);
		assert.ok(pull);
		statHook.removeBeforeStat = resolve(mark);
		assert.deepEqual(await pull(), []);
		assert.equal(statHook.removeBeforeStat, undefined);
		assert.equal(existsSync(mark), false);
	});

	test("a resume that judged a stopped holder never finds the mark half-written by the resume that took over (#5099)", async () => {
		const { clone, remote, head, tree, mark } = await checkout();
		const stopped = { ...(await thisProcess()), pid: exitedPid() };
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote], holder: stopped }));

		// The late resume read the mark naming the stopped holder and is held while it judges that holder.
		const judging = signal();
		const judged = signal();
		statHook.before = {
			path: resolve(mark),
			run: async () => {
				judging.reach();
				await judged.reached;
			},
		};
		let lateSettled = false;
		const late = (await pendingLfsDownload(clone))!()
			.catch((error: unknown) => String((error as Error).message))
			.finally(() => {
				lateSettled = true;
			});
		await judging.reached;

		// The first resume takes the download over. Its writes naming itself are held midway, the second one, made
		// once the takeover mutex is released, until the late resume went on.
		let writes = 0;
		const rewriting = signal();
		const rewritten = signal();
		writeHook.midway = async () => {
			if (++writes !== 2) return;
			rewriting.reach();
			await rewritten.reached;
		};
		const first = (await pendingLfsDownload(clone))!();
		await rewriting.reached;

		readHook.path = resolve(mark);
		judged.reach();
		// It either settles or reads the mark under the takeover mutex and again once it waited.
		const deadline = Date.now() + 30_000;
		while (!lateSettled && readHook.reads < 2) {
			assert.ok(Date.now() < deadline, "the late resume went on");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		rewritten.reach();

		assert.deepEqual(await Promise.all([first, late]), [[], []]);
		assert.equal(existsSync(mark), false, "nothing is pending once the download finished");
	});

	test("a download whose holder stops while it is waited for is taken over (#5099)", async () => {
		const { clone, remote, head, tree, mark } = await checkout();
		const parent = { host: (await thisProcess()).host, pid: process.ppid };
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote], holder: parent }));
		const pull = await pendingLfsDownload(clone);
		assert.ok(pull);
		const waiting = pull();
		await new Promise((resolve) => setTimeout(resolve, 300));
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote], holder: { ...parent, pid: exitedPid() } }));
		assert.deepEqual(await waiting, []);
		assert.equal(existsSync(mark), false, "it finished the download itself");
	});

	test("HEAD left on the snapshot's commit by a download cut off mid-pull still counts as unchanged (#5099)", async () => {
		const { clone, remote, head, tree, mark } = await checkout();
		const identity = {
			GIT_AUTHOR_NAME: "Atomic",
			GIT_AUTHOR_EMAIL: "atomic@localhost",
			GIT_AUTHOR_DATE: "@0 +0000",
			GIT_COMMITTER_NAME: "Atomic",
			GIT_COMMITTER_EMAIL: "atomic@localhost",
			GIT_COMMITTER_DATE: "@0 +0000",
		};
		const recorded = spawnSync(
			"git",
			["commit-tree", "--no-gpg-sign", "-p", head, "-m", "Atomic worktree snapshot", tree],
			{ cwd: clone, encoding: "utf8", env: { ...process.env, ...sandbox.executable.env, ...identity } },
		).stdout.trim();
		assert.match(recorded, /^[0-9a-f]{40,64}$/);
		await sandbox.git(clone, "update-ref", "--no-deref", "HEAD", recorded);
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote] }));

		const pull = await pendingLfsDownload(clone);
		assert.ok(pull);
		await pull();
		assert.equal(await sandbox.git(clone, "rev-parse", "HEAD"), head, "the download puts HEAD back");
	});

	test("a mark that cannot be read fails the download it would finish, rather than being taken as none (#5099)", async () => {
		const { clone, mark } = await checkout();
		mkdirSync(mark);
		await assert.rejects(pendingLfsDownload(clone), { code: "EISDIR" });
	});

	test("a worktree whose HEAD moved since is left as it is, and told once to run git lfs pull (#5099)", async () => {
		const { clone, remote, head, tree, mark } = await checkout();
		writeFileSync(mark, JSON.stringify({ head, tree, remotes: [remote] }));
		sandbox.write(`${clone}/work.txt`, "work\n");
		const moved = await sandbox.commitAll(clone, "work since the restore");

		const pull = await pendingLfsDownload(clone);
		assert.ok(pull);
		await assert.rejects(pull(), CHANGED);
		assert.equal(existsSync(mark), false);
		assert.equal(await sandbox.git(clone, "rev-parse", "HEAD"), moved);
	});

	test.each([
		["a mark that is not JSON", () => "{"],
		[
			"a HEAD with text before it",
			(head: string, tree: string, remote: string) => ({ head: `x${head}`, tree, remotes: [remote] }),
		],
		[
			"a HEAD with text after it",
			(head: string, tree: string, remote: string) => ({ head: `${head}x`, tree, remotes: [remote] }),
		],
		[
			"a HEAD too short for an id",
			(_: string, tree: string, remote: string) => ({ head: "a", tree, remotes: [remote] }),
		],
		[
			"a HEAD of 64 other characters",
			(_: string, tree: string, remote: string) => ({ head: "z".repeat(64), tree, remotes: [remote] }),
		],
		[
			"a tree with text before it",
			(head: string, tree: string, remote: string) => ({ head, tree: `x${tree}`, remotes: [remote] }),
		],
		[
			"a tree with text after it",
			(head: string, tree: string, remote: string) => ({ head, tree: `${tree}x`, remotes: [remote] }),
		],
		[
			"a tree too short for an id",
			(head: string, _: string, remote: string) => ({ head, tree: "a", remotes: [remote] }),
		],
		[
			"a tree of 64 other characters",
			(head: string, _: string, remote: string) => ({ head, tree: "z".repeat(64), remotes: [remote] }),
		],
		[
			"a remote that is not a string",
			(head: string, tree: string, remote: string) => ({ head, tree, remotes: [remote, 5] }),
		],
		[
			"a HEAD that is not a commit id",
			(_: string, tree: string, remote: string) => ({ head: "--all", tree, remotes: [remote] }),
		],
		[
			"a tree that is not an id",
			(head: string, _: string, remote: string) => ({ head, tree: "HEAD", remotes: [remote] }),
		],
		["remotes that are not a list", (head: string, tree: string) => ({ head, tree, remotes: "origin" })],
		["a remote helper", (head: string, tree: string) => ({ head, tree, remotes: ["ext::sh -c id"] })],
		[
			"a process id that is not a number",
			(head: string, tree: string, remote: string) => ({
				head,
				tree,
				remotes: [remote],
				holder: { host: "h", pid: "1" },
			}),
		],
		[
			"a host that is not a string",
			(head: string, tree: string, remote: string) => ({
				head,
				tree,
				remotes: [remote],
				holder: { host: 1, pid: 1 },
			}),
		],
		[
			"a start that is not a string",
			(head: string, tree: string, remote: string) => ({
				head,
				tree,
				remotes: [remote],
				holder: { host: "h", pid: 1, start: 5 },
			}),
		],
	])("%s leaves the worktree as it is and says once to run git lfs pull (#5099)", async (_, mark) => {
		const worktree = await checkout();
		const content = mark(worktree.head, worktree.tree, worktree.remote);
		writeFileSync(worktree.mark, typeof content === "string" ? content : JSON.stringify(content));

		const pull = await pendingLfsDownload(worktree.clone);
		assert.ok(pull);
		await assert.rejects(pull(), CHANGED);
		assert.equal(existsSync(worktree.mark), false);
		assert.equal(await sandbox.git(worktree.clone, "rev-parse", "HEAD"), worktree.head);
	});
});
