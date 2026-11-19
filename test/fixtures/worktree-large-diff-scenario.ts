/**
 * Worktree diff capture scenarios for #4876, shared by the Node suite and its Bun child
 * (`worktree-large-diff-bun.ts`): Node and Bun both cap `spawnSync` output at 1 MiB by default.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holdRunWorktree, registerRunWorktrees } from "../../packages/subagents/src/runs/foreground/run-worktrees.js";
import {
	cleanupWorktrees as cleanupSubagentWorktrees,
	createWorktrees as createSubagentWorktrees,
	diffWorktrees as diffSubagentWorktrees,
	formatWorktreeDiffSummary as formatSubagentWorktreeDiffSummary,
} from "../../packages/subagents/src/runs/shared/worktree.js";

export type WorktreeModule = "subagents";

export interface LargeDiffScenarioResult {
	readonly summary: string;
	readonly largeFileBytes: number;
	readonly largePatchApplied: boolean;
	readonly largePatchStderr: string;
	readonly largeFileRestored: boolean;
	readonly smallFileRestored: boolean;
	readonly worktreesRemoved: boolean;
}

export interface WorktreeIncludeScenarioResult {
	readonly ignoredListingBytes: number;
	readonly envCopied: boolean;
	readonly includedFilesCopied: number;
	readonly notIncludedCopied: boolean;
}

export interface ManyFilesScenarioResult {
	readonly numstatBytes: number;
	readonly summary: string;
	readonly patchApplied: boolean;
	readonly filesRestored: number;
	readonly worktreeRemoved: boolean;
}

export interface NoisyHookScenarioResult {
	readonly created: boolean;
	readonly error: string | undefined;
}

export interface BrokenIncludeScenarioResult {
	readonly error: string | undefined;
	readonly worktreePath: string;
	readonly worktreeCreated: boolean;
	readonly setupWarnings: readonly string[] | undefined;
	readonly summary: string;
}

export interface FailedCaptureScenarioResult {
	readonly summary: string;
	readonly worktreePath: string;
	readonly worktreeKept: boolean;
	readonly workKept: boolean;
	readonly captureError: string | undefined;
	/** Whether a later sweep, once capture works again, saved the work and removed the worktree. */
	readonly laterSweepSavedWork?: boolean;
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

/** A clean repository with one commit, inside `root`. */
export function createScenarioRepository(root: string): string {
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.name", "Atomic Test"]);
	git(repo, ["config", "user.email", "atomic@example.com"]);
	git(repo, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	git(repo, ["add", "seed.txt"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "initial"]);
	return repo;
}

/** About 2 MB of distinct text lines: a generated file or lockfile, well over the 1 MiB output cap. */
function largeGeneratedFile(): string {
	const lines: string[] = [];
	for (let line = 0; line < 30_000; line++) {
		lines.push(`${line}:${createHash("sha256").update(String(line)).digest("hex")}`);
	}
	return `${lines.join("\n")}\n`;
}

const api = {
	create: createSubagentWorktrees,
	diff: diffSubagentWorktrees,
	cleanup: cleanupSubagentWorktrees,
	format: formatSubagentWorktreeDiffSummary,
};

/**
 * Two worktree tasks, one adding a ~2 MB file and one a small file; their diffs are captured and their worktrees
 * removed, as a run does when it returns. The large task's patch is then applied to a clean checkout.
 */
export async function runLargeDiffScenario(root: string, module: WorktreeModule): Promise<LargeDiffScenarioResult> {
	const repo = createScenarioRepository(root);
	// The third task changes nothing.
	const setup = await api.create(repo, `large-${module}`, 3);
	const large = largeGeneratedFile();
	writeFileSync(join(setup.worktrees[0]!.path, "generated.lock"), large);
	writeFileSync(join(setup.worktrees[1]!.path, "small.txt"), "small change\n");
	const diffs = await api.diff(setup, ["large", "small", "unchanged"], join(root, "diffs"));
	await api.cleanup(setup);
	const clean = join(root, "clean");
	git(repo, ["worktree", "add", "--detach", clean, "HEAD"]);
	const applied = spawnSync("git", ["-C", clean, "apply", "--whitespace=nowarn", diffs[0]!.patchPath], {
		encoding: "utf-8",
	});
	const smallApplied = spawnSync("git", ["-C", clean, "apply", "--whitespace=nowarn", diffs[1]!.patchPath], {
		encoding: "utf-8",
	});
	const largePath = join(clean, "generated.lock");
	const smallPath = join(clean, "small.txt");
	return {
		summary: api.format(diffs),
		largeFileBytes: Buffer.byteLength(large),
		largePatchApplied: applied.status === 0,
		largePatchStderr: applied.stderr,
		largeFileRestored: existsSync(largePath) && readFileSync(largePath, "utf-8") === large,
		smallFileRestored:
			smallApplied.status === 0 && existsSync(smallPath) && readFileSync(smallPath, "utf-8") === "small change\n",
		worktreesRemoved: setup.worktrees.every((worktree) => !existsSync(worktree.path)),
	};
}

/**
 * One worktree task with work whose diff capture fails (its index is locked), captured and then released as a parallel
 * subagent run does when it returns.
 */
export async function runFailedCaptureScenario(
	root: string,
	module: WorktreeModule,
): Promise<FailedCaptureScenarioResult> {
	const repo = createScenarioRepository(root);
	const runId = `failed-${module}`;
	const setup = await api.create(repo, runId, 1);
	const worktree = setup.worktrees[0]!;
	writeFileSync(join(worktree.path, "work.txt"), "the child's work\n");
	const gitDir = git(worktree.path, ["rev-parse", "--absolute-git-dir"]).trim();
	writeFileSync(join(gitDir, "index.lock"), "");
	const diffsDir = join(root, "diffs");
	const diffs = await api.diff(setup, ["worker"], diffsDir);
	await registerRunWorktrees(runId, setup, { diffsDir, agents: ["worker"] }).release();
	const diff = diffs[0] as { captureError?: string } | undefined;
	const result = {
		summary: api.format(diffs),
		worktreePath: worktree.path,
		worktreeKept: existsSync(worktree.path),
		workKept: existsSync(join(worktree.path, "work.txt")),
		captureError: diff?.captureError,
	};
	// The index unlocks; the next execution's release sweeps the run again.
	rmSync(join(gitDir, "index.lock"));
	await holdRunWorktree(runId, 0)();
	const patch = join(diffsDir, "task-0-worker.patch");
	const laterSweepSavedWork =
		!existsSync(worktree.path) && existsSync(patch) && readFileSync(patch, "utf-8").includes("the child's work");
	return { ...result, laterSweepSavedWork };
}

/**
 * A repository whose ignored files list to well over 1 MiB (an installed `node_modules`), with `.env` named in
 * `.worktreeinclude`: a new worktree must still receive `.env`.
 */
export const INCLUDED_CONFIG_FILES = 199;
export async function runWorktreeIncludeScenario(
	root: string,
	module: WorktreeModule,
): Promise<WorktreeIncludeScenarioResult> {
	const repo = createScenarioRepository(root);
	writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\nconfig/\nbuild.log\n");
	writeFileSync(join(repo, ".worktreeinclude"), ".env\nconfig/\n");
	git(repo, ["add", ".gitignore", ".worktreeinclude"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "ignore rules"]);
	writeFileSync(join(repo, ".env"), "SECRET=1\n");
	// More included files than one git call checks, and an ignored file .worktreeinclude does not name.
	mkdirSync(join(repo, "config"));
	// With .env, the included files fill exactly two git calls.
	for (let file = 0; file < INCLUDED_CONFIG_FILES; file++)
		writeFileSync(join(repo, "config", `local-${file}.json`), `${file}\n`);
	writeFileSync(join(repo, "build.log"), "not included\n");
	// Creating files is slow on Windows, so the listing is made large from few of them: names of 80 CJK characters take
	// 240 UTF-8 bytes each, under the 255-byte file name limit. Git for Windows needs core.longpaths for these paths.
	git(repo, ["config", "core.longpaths", "true"]);
	const name = "依".repeat(80);
	for (let pkg = 0; pkg < 8; pkg++) {
		const directory = join(repo, "node_modules", `dependency-${pkg}`, name, name);
		mkdirSync(directory, { recursive: true });
		for (let file = 0; file < 200; file++) writeFileSync(join(directory, `${name}-${file}.js`), "");
	}
	const listing = git(repo, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]);
	const setup = await api.create(repo, `include-${module}`, 1);
	const envPath = join(setup.worktrees[0]!.path, ".env");
	const envCopied = existsSync(envPath) && readFileSync(envPath, "utf-8") === "SECRET=1\n";
	let includedFilesCopied = 0;
	for (let file = 0; file < INCLUDED_CONFIG_FILES; file++) {
		const copied = join(setup.worktrees[0]!.path, "config", `local-${file}.json`);
		if (existsSync(copied) && readFileSync(copied, "utf-8") === `${file}\n`) includedFilesCopied++;
	}
	const notIncludedCopied = existsSync(join(setup.worktrees[0]!.path, "build.log"));
	await api.cleanup(setup);
	return { ignoredListingBytes: Buffer.byteLength(listing), envCopied, includedFilesCopied, notIncludedCopied };
}

/**
 * A worktree change of 400 files whose numstat lists to over 1 MiB. Git quotes a non-ASCII path, writing each byte of
 * it as a four-character octal escape, so a path of 240 CJK characters takes 2,880 bytes on its numstat line.
 */
export const MANY_FILES = 400;
export async function runManyFilesScenario(root: string, module: WorktreeModule): Promise<ManyFilesScenarioResult> {
	const repo = createScenarioRepository(root);
	// Quoting is git's default; set it so a global `core.quotePath false` cannot shrink the listing under 1 MiB.
	// The paths are longer than Windows' 260 characters, which Git for Windows handles only with this setting.
	git(repo, ["config", "core.longpaths", "true"]);
	const setup = await api.create(repo, `many-${module}`, 1);
	// Each component is 240 UTF-8 bytes, under the 255-byte file name limit; the whole path stays under macOS' 1,024.
	const component = "語".repeat(80);
	const directoryName = join(component, component, component);
	const directory = join(setup.worktrees[0]!.path, directoryName);
	mkdirSync(directory, { recursive: true });
	for (let file = 0; file < MANY_FILES; file++) writeFileSync(join(directory, `f-${file}.txt`), `${file}\n`);
	git(setup.worktrees[0]!.path, ["add", "-A"]);
	const numstat = git(setup.worktrees[0]!.path, ["diff", "--cached", "--numstat", "HEAD"]);
	const diffs = await api.diff(setup, ["many"], join(root, "diffs"));
	await api.cleanup(setup);
	const clean = join(root, "clean");
	git(repo, ["worktree", "add", "--detach", clean, "HEAD"]);
	const applied = spawnSync("git", ["-C", clean, "apply", diffs[0]!.patchPath], { encoding: "utf-8" });
	let filesRestored = 0;
	for (let file = 0; file < MANY_FILES; file++) {
		const restored = join(clean, directoryName, `f-${file}.txt`);
		if (existsSync(restored) && readFileSync(restored, "utf-8") === `${file}\n`) filesRestored++;
	}
	return {
		numstatBytes: Buffer.byteLength(numstat),
		summary: api.format(diffs),
		patchApplied: applied.status === 0,
		filesRestored,
		worktreeRemoved: !existsSync(setup.worktrees[0]!.path),
	};
}

/** A setup hook that logs over 1 MiB to stderr before printing its JSON result (POSIX shell). */
export async function runNoisyHookScenario(root: string, module: WorktreeModule): Promise<NoisyHookScenarioResult> {
	const repo = createScenarioRepository(root);
	const hook = join(root, "noisy-hook.sh");
	writeFileSync(hook, "#!/bin/sh\nhead -c 2000000 /dev/zero | tr '\\0' x >&2\necho '{}'\n", { mode: 0o755 });
	try {
		const setup = await api.create(repo, `hook-${module}`, 1, { setupHook: { hookPath: hook } });
		const created = existsSync(setup.worktrees[0]!.path);
		await api.cleanup(setup);
		return { created, error: undefined };
	} catch (error) {
		return { created: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * A `.worktreeinclude` git cannot read (a directory): the worktree is still created, without the included files, and
 * its diff and the summary carry a warning.
 */
export async function runBrokenIncludeScenario(
	root: string,
	module: WorktreeModule,
): Promise<BrokenIncludeScenarioResult> {
	const repo = createScenarioRepository(root);
	mkdirSync(join(repo, ".worktreeinclude"));
	let setup: Awaited<ReturnType<typeof api.create>>;
	try {
		setup = await api.create(repo, `broken-${module}`, 1);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: message, worktreePath: "", worktreeCreated: false, setupWarnings: undefined, summary: "" };
	}
	const worktreePath = setup.worktrees[0]!.path;
	const worktreeCreated = existsSync(worktreePath);
	const diffs = await api.diff(setup, ["worker"], join(root, "diffs"));
	await api.cleanup(setup);
	return {
		error: undefined,
		worktreePath,
		worktreeCreated,
		setupWarnings: (diffs[0] as { setupWarnings?: string[] } | undefined)?.setupWarnings,
		summary: api.format(diffs),
	};
}
