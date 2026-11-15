/**
 * Worktree diff capture scenarios for #4876, shared by the Node suite and its Bun child
 * (`worktree-large-diff-bun.ts`): Node and Bun both cap `spawnSync` output at 1 MiB by default.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerRunWorktrees } from "../../packages/subagents/src/runs/foreground/run-worktrees.js";
import {
	cleanupWorktrees as cleanupSubagentWorktrees,
	createWorktrees as createSubagentWorktrees,
	diffWorktrees as diffSubagentWorktrees,
	formatWorktreeDiffSummary as formatSubagentWorktreeDiffSummary,
} from "../../packages/subagents/src/runs/shared/worktree.js";
import {
	cleanupWorktrees as cleanupWorkflowWorktrees,
	createWorktrees as createWorkflowWorktrees,
	diffWorktrees as diffWorkflowWorktrees,
	formatWorktreeDiffSummary as formatWorkflowWorktreeDiffSummary,
} from "../../packages/workflows/src/runs/shared/worktree.js";

export type WorktreeModule = "subagents" | "workflows";

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
}

export interface FailedCaptureScenarioResult {
	readonly summary: string;
	readonly worktreePath: string;
	readonly worktreeKept: boolean;
	readonly workKept: boolean;
	readonly captureError: string | undefined;
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

function modules(module: WorktreeModule) {
	return module === "subagents"
		? {
				create: createSubagentWorktrees,
				diff: diffSubagentWorktrees,
				cleanup: cleanupSubagentWorktrees,
				format: formatSubagentWorktreeDiffSummary,
			}
		: {
				create: createWorkflowWorktrees,
				diff: diffWorkflowWorktrees,
				cleanup: cleanupWorkflowWorktrees,
				format: formatWorkflowWorktreeDiffSummary,
			};
}

/**
 * Two worktree tasks, one adding a ~2 MB file and one a small file; their diffs are captured and their worktrees
 * removed, as a run does when it returns. The large task's patch is then applied to a clean checkout.
 */
export function runLargeDiffScenario(root: string, module: WorktreeModule): LargeDiffScenarioResult {
	const repo = createScenarioRepository(root);
	const api = modules(module);
	const setup = api.create(repo, `large-${module}`, 2);
	const large = largeGeneratedFile();
	writeFileSync(join(setup.worktrees[0]!.path, "generated.lock"), large);
	writeFileSync(join(setup.worktrees[1]!.path, "small.txt"), "small change\n");
	const diffs = api.diff(setup, ["large", "small"], join(root, "diffs"));
	api.cleanup(setup);
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
export function runFailedCaptureScenario(root: string, module: WorktreeModule): FailedCaptureScenarioResult {
	const repo = createScenarioRepository(root);
	const api = modules(module);
	const runId = `failed-${module}`;
	const setup = api.create(repo, runId, 1);
	const worktree = setup.worktrees[0]!;
	writeFileSync(join(worktree.path, "work.txt"), "the child's work\n");
	const gitDir = git(worktree.path, ["rev-parse", "--absolute-git-dir"]).trim();
	writeFileSync(join(gitDir, "index.lock"), "");
	const diffsDir = join(root, "diffs");
	const diffs = api.diff(setup, ["worker"], diffsDir);
	if (module === "subagents") {
		registerRunWorktrees(runId, setup, { diffsDir, agents: ["worker"] }).release();
	} else {
		api.cleanup(setup);
	}
	const diff = diffs[0] as { captureError?: string } | undefined;
	return {
		summary: api.format(diffs),
		worktreePath: worktree.path,
		worktreeKept: existsSync(worktree.path),
		workKept: existsSync(join(worktree.path, "work.txt")),
		captureError: diff?.captureError,
	};
}

/**
 * A repository whose ignored files list to well over 1 MiB (an installed `node_modules`), with `.env` named in
 * `.worktreeinclude`: a new worktree must still receive `.env`.
 */
export function runWorktreeIncludeScenario(root: string, module: WorktreeModule): WorktreeIncludeScenarioResult {
	const repo = createScenarioRepository(root);
	writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
	writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
	git(repo, ["add", ".gitignore", ".worktreeinclude"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "ignore rules"]);
	writeFileSync(join(repo, ".env"), "SECRET=1\n");
	// Long package names make the listing large from few files: creating files is slow on Windows. Each path stays well
	// under Windows' 260-character limit.
	for (let pkg = 0; pkg < 40; pkg++) {
		const directory = join(repo, "node_modules", `dependency-${pkg}-${"x".repeat(110)}`);
		mkdirSync(directory, { recursive: true });
		for (let file = 0; file < 200; file++) writeFileSync(join(directory, `module-file-${file}.js`), "");
	}
	const listing = git(repo, ["ls-files", "--others", "--ignored", "--exclude-standard"]);
	const api = modules(module);
	const setup = api.create(repo, `include-${module}`, 1);
	const envPath = join(setup.worktrees[0]!.path, ".env");
	const envCopied = existsSync(envPath) && readFileSync(envPath, "utf-8") === "SECRET=1\n";
	api.cleanup(setup);
	return { ignoredListingBytes: Buffer.byteLength(listing), envCopied };
}
