import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	observeWorkspaceGitCommands,
	setWorkspaceGitExecutableResolver,
} from "../../packages/coding-agent/src/core/workspace/git.ts";

/** Run git for test setup only; product code goes through the workspace git runner. */
export function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "Test User",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test User",
			GIT_COMMITTER_EMAIL: "test@example.com",
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: "commit.gpgsign",
			GIT_CONFIG_VALUE_0: "false",
			GIT_CONFIG_KEY_1: "tag.gpgsign",
			GIT_CONFIG_VALUE_1: "false",
		},
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	return result.stdout.trim();
}

export interface WorkspaceSandboxDirs {
	readonly root: string;
	/** Atomic home for the test: `ATOMIC_CODING_AGENT_DIR` points at `<home>/agent`. */
	readonly home: string;
	cleanup(): void;
}

/** A temporary root with its own Atomic home, so shared stores and auto worktrees never touch the real one. */
export function workspaceSandbox(prefix: string): WorkspaceSandboxDirs {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
	const home = join(root, "atomic-home");
	mkdirSync(join(home, "agent"), { recursive: true });
	const previous = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = join(home, "agent");
	return {
		root,
		home,
		cleanup() {
			if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
			else process.env.ATOMIC_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** A repository with one commit on `main`. */
export function createRepository(parent: string, name: string): string {
	const repo = join(parent, name);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test User");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), `${name}\n`);
	git(repo, "add", "README.md");
	git(repo, "commit", "-q", "-m", "initial");
	return repo;
}

export function commitFile(repo: string, file: string, content: string): string {
	writeFileSync(join(repo, file), content);
	git(repo, "add", file);
	git(repo, "commit", "-q", "-m", `change ${file}`);
	return git(repo, "rev-parse", "HEAD");
}

/** A bare remote seeded from a fresh repository, reachable through a `file://` URL. */
export function createRemote(parent: string, name: string): { readonly url: string; readonly seed: string } {
	const seed = createRepository(parent, `${name}-seed`);
	const bare = join(parent, `${name}.git`);
	git(parent, "clone", "-q", "--bare", seed, bare);
	return { url: `file://${bare.replaceAll("\\", "/").replace(/^(?=[A-Za-z]:)/, "/")}`, seed };
}

/** Count workspace git commands by their first argument (`clone`, `worktree`, …) while `body` runs. */
export async function countGitCommands<T>(
	body: () => Promise<T>,
): Promise<{ readonly result: T; readonly commands: readonly (readonly string[])[] }> {
	const commands: (readonly string[])[] = [];
	const stop = observeWorkspaceGitCommands((command) => commands.push(command.args));
	try {
		return { result: await body(), commands };
	} finally {
		stop();
	}
}

/** Every workspace git command run while `body` runs, as `<phase>: <args>` with `replacements` applied in order. */
export async function gitTranscript<T>(
	body: () => Promise<T>,
	replacements: readonly (readonly [string | RegExp, string])[] = [],
): Promise<{ readonly result: T; readonly transcript: readonly string[] }> {
	const transcript: string[] = [];
	const stop = observeWorkspaceGitCommands((command) => {
		let line = `${command.phase}: ${command.args.join(" ")}`;
		for (const [pattern, replacement] of replacements) line = line.replaceAll(pattern, replacement);
		transcript.push(line);
	});
	try {
		return { result: await body(), transcript };
	} finally {
		stop();
	}
}

/**
 * A POSIX shell git that runs the real one, except for the failure or delay its environment selects:
 * `FAKE_GIT_MODE` picks an injected failure, and `FAKE_GIT_SLOW` (`"<subcommand> <first argument>"`) delays that
 * command by `FAKE_GIT_SLEEP` seconds, once the file `FAKE_GIT_ARMED` exists when that is set, then touches
 * `FAKE_GIT_MARKER` if it was not killed meanwhile.
 */
function fakeGit(root: string): string {
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
	const path = join(root, "fake-git");
	writeFileSync(
		path,
		`#!/bin/sh
real='${real}'
store="\${PWD%.tmp-*}"
if [ -n "$FAKE_GIT_SLOW" ] && [ "$5 $6" = "$FAKE_GIT_SLOW" ] && { [ -z "$FAKE_GIT_ARMED" ] || [ -e "$FAKE_GIT_ARMED" ]; }; then
	sleep "$FAKE_GIT_SLEEP"
	: > "$FAKE_GIT_MARKER"
fi
case "$FAKE_GIT_MODE:$5 $6" in
"staging-fetch:fetch origin"|"unremovable-staging:fetch origin"|"winner-store:fetch origin"|"empty-store:fetch origin")
	case "$PWD" in *.tmp-*) ;; *) exec "$real" "$@" ;; esac
	case "$FAKE_GIT_MODE" in
	unremovable-staging) parent=$(dirname "$PWD"); mv "$parent" "$parent.moved"; : > "$parent" ;;
	winner-store) "$real" fetch -q origin && cp -R "$PWD" "$store" ;;
	empty-store) mkdir "$store" ;;
	esac
	echo "injected fetch failure" >&2
	exit 1 ;;
"read-tree:read-tree HEAD")
	echo "injected read-tree failure" >&2
	exit 1 ;;
"slow-worktree-add:worktree add")
	if [ "$7" = "-b" ]; then target="$9"; else target="$7"; fi
	mkdir -p "$target"
	sleep 1 ;;
esac
exec "$real" "$@"
`,
	);
	chmodSync(path, 0o755);
	return path;
}

/** Run `body` with workspace git commands going through the fake git under `env`. POSIX only. */
export async function withInjectedGit<T>(
	root: string,
	env: Readonly<Record<string, string>>,
	body: () => Promise<T>,
): Promise<T> {
	const path = fakeGit(root);
	const restore = setWorkspaceGitExecutableResolver(async () => ({ path, env }));
	try {
		return await body();
	} finally {
		restore();
	}
}
