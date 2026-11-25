import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import {
	type MemorySnapshotBlobStore,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import type { WorktreeSnapshotCapture } from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { isWorkspaceSnapshotError } from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";
import {
	type GitExecutable,
	runGit,
	setWorktreeSnapshotGit,
} from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import { removeTestDirectory } from "./test-directory-removal.js";

/**
 * The most one real git process may take on a loaded CI host. Windows starts one in about 90 ms when idle, several times
 * that beside other suites. A test that starts many budgets them at this each, and asserts it starts no more.
 */
export const GIT_PROCESS_BUDGET_MS = 300;

/**
 * The git processes started since `trace` was named as their `GIT_TRACE2_EVENT` target, each with its arguments; the git
 * processes git starts for itself count too.
 */
export function startedGitProcesses(trace: string): { readonly argv?: readonly string[] }[] {
	return readFileSync(trace, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; argv?: string[] })
		.filter((event) => event.event === "start");
}

/** The error code for a path below a regular file: POSIX systems say ENOTDIR, Windows reports the path as missing. */
export const BELOW_FILE_ERRNO = process.platform === "win32" ? "ENOENT" : "ENOTDIR";

export const COPY_DIRECTORY_ERRNO =
	process.platform === "darwin" ? "ENOTSUP" : process.platform === "win32" ? "EPERM" : "EISDIR";

/** `path` as a Git config value: forward slashes, which Git reads on every platform, where backslashes would be escapes. */
export function gitConfigPath(path: string): string {
	return path.replace(/\\/g, "/");
}

/** The Git LFS pointer of `content`: what an LFS file holds until its object is fetched. */
export function lfsPointer(content: string): string {
	const oid = createHash("sha256").update(content).digest("hex");
	return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(content)}\n`;
}

/**
 * Removes `hashes` from `store` whether or not anything references them, as storage that lost them would. Stores
 * expose no such delete: collection only removes unreferenced blobs, so tests reach the store's own table or map.
 */
export async function loseSnapshotBlobs(
	store: SqlSnapshotBlobStore | MemorySnapshotBlobStore,
	hashes: readonly string[],
): Promise<void> {
	if (store instanceof SqlSnapshotBlobStore) {
		const { database } = store as unknown as { readonly database: SqliteDatabase };
		for (const hash of hashes) await database.run(`DELETE FROM ${store.table} WHERE hash = ?`, hash);
		return;
	}
	const { blobs } = store as unknown as { readonly blobs: Map<string, Uint8Array> };
	for (const hash of hashes) blobs.delete(hash);
}

/** Asserts `error` is the typed `unreadable-path` snapshot error for `path`, caused by the filesystem error `errno`. */
export function assertUnreadablePath(error: unknown, path: string, errno: string): void {
	assert.ok(isWorkspaceSnapshotError(error), `expected an unreadable-path error, got ${String(error)}`);
	assert.equal(error.code, "unreadable-path");
	assert.equal(resolve(error.subject), resolve(path));
	assert.equal((error.cause as NodeJS.ErrnoException).code, errno);
}

/** Asserts a capture was unavailable because `path` could not be read, with filesystem error `errno`. */
export function assertCaptureUnreadable(result: WorktreeSnapshotCapture, path: string, errno: string): void {
	assert.equal(result.status, "unavailable");
	assertUnreadablePath((result as Extract<WorktreeSnapshotCapture, { status: "unavailable" }>).reason, path, errno);
}

/**
 * Windows can keep a restored worktree busy for seconds after the processes that worked in it ended, while the search
 * indexer, an antivirus scan or a terminated build step's handles still hold it. A removal it refuses is tried again,
 * 50 ms later each time, for about 20 seconds while the next tests run.
 */
const SANDBOX_REMOVAL_RETRIES = 28;
const SANDBOX_REMOVAL_RETRY_DELAY_MS = 50;

/**
 * Disposable Git repositories whose commands all go through the snapshot runner with an isolated global config, so
 * the developer's signing, hooks and filter settings never reach a fixture.
 */
export class GitSandbox {
	readonly root: string;
	readonly globalConfig: string;
	readonly executable: GitExecutable;
	private readonly restoreResolver: () => void;

	constructor(extraGlobalConfig = "") {
		this.root = realpathSync.native(mkdtempSync(join(tmpdir(), "atomic-snapshot-test-")));
		this.globalConfig = join(this.root, "gitconfig");
		writeFileSync(
			this.globalConfig,
			`[user]\n\tname = Fixture\n\temail = fixture@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n[protocol "file"]\n\tallow = always\n${extraGlobalConfig}`,
		);
		this.executable = {
			path: "git",
			env: { GIT_CONFIG_GLOBAL: this.globalConfig, GIT_CONFIG_NOSYSTEM: "1", HOME: this.root },
		};
		const executable = this.executable;
		const previous = setWorktreeSnapshotGit(async () => executable);
		this.restoreResolver = () => setWorktreeSnapshotGit(previous);
	}

	path(...parts: string[]): string {
		return join(this.root, ...parts);
	}

	async git(cwd: string, ...args: string[]): Promise<string> {
		const { stdout } = await runGit(args, { cwd });
		return stdout.toString("utf8").replace(/\n$/, "");
	}

	write(path: string, content: string | Uint8Array): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	/** A bare remote with one pushed commit and a clone of it, both under the sandbox. */
	async remoteWithClone(name = "repo", files: Record<string, string | Uint8Array> = { "README.md": "hello\n" }) {
		const remote = this.path(`${name}.git`);
		await this.git(this.root, "init", "-q", "--bare", remote);
		const clone = this.path(name);
		await this.git(this.root, "clone", "-q", remote, clone);
		for (const [file, content] of Object.entries(files)) this.write(join(clone, file), content);
		await this.git(clone, "add", "-A");
		await this.git(clone, "commit", "-q", "-m", "initial");
		await this.git(clone, "push", "-q", "origin", "HEAD:main");
		await this.git(clone, "branch", "-q", "--set-upstream-to=origin/main");
		return { remote, clone };
	}

	async commitAll(cwd: string, message: string): Promise<string> {
		await this.git(cwd, "add", "-A");
		await this.git(cwd, "commit", "-q", "-m", message);
		return this.git(cwd, "rev-parse", "HEAD");
	}

	/** Traces every git process the snapshot runner starts from now on, and those they start; returns the trace's path. */
	traceGitProcesses(): string {
		const trace = this.path("git-trace.jsonl");
		const executable = { ...this.executable, env: { ...this.executable.env, GIT_TRACE2_EVENT: trace } };
		setWorktreeSnapshotGit(async () => executable);
		return trace;
	}

	dispose(): void {
		this.restoreResolver();
		removeTestDirectory(this.root, {
			retries: SANDBOX_REMOVAL_RETRIES,
			retryDelayMs: SANDBOX_REMOVAL_RETRY_DELAY_MS,
		});
	}
}
