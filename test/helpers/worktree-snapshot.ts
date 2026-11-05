import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { WorktreeSnapshotCapture } from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { isWorkspaceSnapshotError } from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";
import {
	type GitExecutable,
	runGit,
	setWorktreeSnapshotGit,
} from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";

/** The error code for a path below a regular file: POSIX systems say ENOTDIR, Windows reports the path as missing. */
export const BELOW_FILE_ERRNO = process.platform === "win32" ? "ENOENT" : "ENOTDIR";

/** The error code for opening a directory as a file: EISDIR on POSIX systems, EPERM on Windows. */
export const DIRECTORY_AS_FILE_ERRNO = process.platform === "win32" ? "EPERM" : "EISDIR";

/** `path` as a Git config value: forward slashes, which Git reads on every platform, where backslashes would be escapes. */
export function gitConfigPath(path: string): string {
	return path.replace(/\\/g, "/");
}

/** The Git LFS pointer of `content`: what an LFS file holds until its object is fetched. */
export function lfsPointer(content: string): string {
	const oid = createHash("sha256").update(content).digest("hex");
	return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(content)}\n`;
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

	dispose(): void {
		this.restoreResolver();
		rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
}
