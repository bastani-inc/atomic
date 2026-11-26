import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bunExecutable } from "../../helpers/runtime.js";

/** The Git on this machine's PATH. */
export function gitOnPath(): string {
	return execFileSync("sh", ["-c", "command -v git"]).toString().trim();
}

/**
 * This machine's Git packed as Atomic's portable Git archive (`bin/git`, `libexec/git-core`, templates, an empty system
 * config and CA bundle), with its SHA-256 and version, so a node without Git can provision a working one offline.
 */
export function portableGitArchive(root: string): { archive: string; sha256: string; version: string } {
	const git = gitOnPath();
	const execPath = execFileSync(git, ["--exec-path"]).toString().trim();
	const source = join(root, "portable-git");
	for (const dir of ["bin", "libexec", "share/git-core", "etc", "ssl"])
		mkdirSync(join(source, dir), { recursive: true });
	// The git in exec-path is the real binary; the one on PATH can be a launcher, as /usr/bin/git is on macOS.
	const binary = existsSync(join(execPath, "git")) ? join(execPath, "git") : git;
	copyFileSync(realpathSync(binary), join(source, "bin", "git"));
	chmodSync(join(source, "bin", "git"), 0o755);
	cpSync(execPath, join(source, "libexec", "git-core"), { recursive: true, verbatimSymlinks: true });
	const templates = join(execPath, "..", "..", "share", "git-core", "templates");
	if (existsSync(templates)) cpSync(templates, join(source, "share", "git-core", "templates"), { recursive: true });
	else mkdirSync(join(source, "share", "git-core", "templates"));
	writeFileSync(join(source, "etc", "gitconfig"), "");
	writeFileSync(join(source, "ssl", "cacert.pem"), "");
	const archive = join(root, "portable-git.tar.gz");
	execFileSync("tar", ["czf", archive, "-C", source, "."]);
	const version = /git version (\S+)/.exec(execFileSync(git, ["--version"]).toString())?.[1] ?? "";
	return { archive, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"), version };
}

/**
 * A directory holding only Bun, for a PATH without Git: the directory Bun is installed in may hold Git too, as
 * Homebrew's does.
 */
export function bunOnly(root: string): string {
	const dir = join(root, "bun-only");
	if (existsSync(dir)) return dir;
	mkdirSync(dir, { recursive: true });
	symlinkSync(bunExecutable(), join(dir, "bun"));
	return dir;
}

/** A directory holding only the tools Git provisioning unpacks with, for a PATH without Git. */
export function provisioningTools(root: string): string {
	const tools = join(root, "provisioning-tools");
	if (existsSync(tools)) return tools;
	mkdirSync(tools, { recursive: true });
	for (const tool of ["tar", "gzip"])
		symlinkSync(
			execFileSync("sh", ["-c", `command -v ${tool}`])
				.toString()
				.trim(),
			join(tools, tool),
		);
	return tools;
}

/**
 * A `git` that runs the real one, and the first time it is asked to `worktree add`, SIGKILLs the process that called
 * it right after: a node that crashes in the middle of restoring a worktree. Returns the directory to put first on PATH.
 */
export function gitKillingTheFirstRestore(dir: string): { path: string; killed: string } {
	mkdirSync(dir, { recursive: true });
	const killed = join(dir, "killed-mid-restore");
	writeFileSync(
		join(dir, "git"),
		`#!/bin/sh\n"${gitOnPath()}" "$@"\nstatus=$?\ncase "$*" in *"worktree add"*) if [ ! -e "${killed}" ]; then : > "${killed}"; kill -9 $PPID; fi;; esac\nexit $status\n`,
	);
	chmodSync(join(dir, "git"), 0o755);
	return { path: dir, killed };
}
