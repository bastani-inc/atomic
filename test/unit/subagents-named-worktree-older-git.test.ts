import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { ensureNamedWorktree } from "../../packages/subagents/src/runs/shared/named-worktree.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", ...args], { cwd, env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString("utf8").trim();
}

function temporaryDirectory(prefix: string): string {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/**
 * Puts `bin` first on PATH, with `env`, for the rest of the test, and a home directory of its own: Git before 2.32
 * reads no `GIT_CONFIG_GLOBAL`, and would read the developer's global settings, which it may not understand.
 */
function useGitFrom(bin: string, extra: Record<string, string> = {}): void {
	const home = temporaryDirectory("atomic-git-home-");
	const env = { ...extra, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" };
	const previous = {
		PATH: process.env.PATH,
		GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
		...Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])),
	};
	delete process.env.GIT_CONFIG_GLOBAL;
	process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
	Object.assign(process.env, env);
	cleanups.push(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

/** A directory holding a `git` that refuses `worktree add --reason` as Git 2.30 does and runs the installed Git otherwise. */
function gitWithoutAddReason(): string {
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const bin = temporaryDirectory("atomic-git-2.30-");
	const script = join(bin, "git");
	writeFileSync(
		script,
		`#!/bin/sh
case " $* " in
*" worktree add "*" --reason "*) echo "error: unknown option \\\`reason'" >&2; exit 129 ;;
esac
exec "${real}" "$@"
`,
	);
	chmodSync(script, 0o755);
	return bin;
}

/** Git installs named in `ATOMIC_TEST_OLDER_GIT` (prefixes separated as PATH is), such as Git 2.30 built from source. */
function olderGitInstalls(): { readonly name: string; readonly use: () => void }[] {
	const installs: { name: string; use: () => void }[] = [];
	if (process.platform !== "win32")
		installs.push({ name: "a Git without `worktree add --reason`", use: () => useGitFrom(gitWithoutAddReason()) });
	for (const prefix of (process.env.ATOMIC_TEST_OLDER_GIT ?? "").split(delimiter).filter(Boolean)) {
		const bin = join(prefix, "bin");
		const env = { GIT_EXEC_PATH: join(prefix, "libexec", "git-core") };
		if (!existsSync(join(bin, process.platform === "win32" ? "git.exe" : "git"))) continue;
		const version = execFileSync(join(bin, "git"), ["--version"], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		installs.push({ name: version.trim(), use: () => useGitFrom(bin, env) });
	}
	return installs;
}

for (const { name, use } of olderGitInstalls()) {
	test(`a named worktree is created, left unlocked and reused with ${name}`, async () => {
		use();
		const repo = join(temporaryDirectory("atomic-named-worktree-older-"), "repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		git(repo, "config", "commit.gpgsign", "false");
		writeFileSync(join(repo, "README.md"), "hello\n");
		git(repo, "add", "README.md");
		git(repo, "commit", "-q", "-m", "init");

		const created = await ensureNamedWorktree(repo, { branch: "feat/older-git" });
		assert.equal(git(created.path, "branch", "--show-current"), "feat/older-git");
		assert.equal(readFileSync(join(created.path, "README.md"), "utf8"), "hello\n");
		const gitDir = git(created.path, "rev-parse", "--absolute-git-dir");
		assert.equal(existsSync(join(gitDir, "locked")), false, "the worktree is not left locked");
		const reused = await ensureNamedWorktree(repo, { branch: "feat/older-git" });
		assert.equal(reused.path, created.path);
	});
}
