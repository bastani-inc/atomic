import { spawn } from "node:child_process";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { isWorkspaceBindingError, WorkspacePublicationError } from "./errors.ts";
import { assertWorkspaceGitAvailable, gitOutput, runWorkspaceGit } from "./git.ts";
import { redactCredentials } from "./redact.ts";
import { type BoundWorkspace, openWorkspaceRepository } from "./resolve.ts";
import { classifyRepository } from "./spec.ts";

export type WorkspaceDiffStat = {
	readonly files: number;
	readonly insertions: number;
	readonly deletions: number;
};

/** What a bound stage or child workflow committed: from the binding's base commit to the branch head. */
export type WorkspaceChangeSet = {
	readonly repo: string;
	readonly baseCommit: string;
	readonly branch: string;
	readonly headCommit: string;
	readonly diffStat: WorkspaceDiffStat;
};

export interface WorkspaceChangeSetOptions {
	readonly signal?: AbortSignal;
}

/** Committed changes in a bound worktree since its base commit. Uncommitted changes are not part of a change set. */
export async function workspaceChangeSet(
	binding: Pick<BoundWorkspace, "repo" | "baseCommit" | "branch" | "worktree">,
	options: WorkspaceChangeSetOptions = {},
): Promise<WorkspaceChangeSet> {
	const signal = options.signal;
	const run = (args: readonly string[]) => gitOutput({ cwd: binding.worktree, args, phase: "change-set", signal });
	const headCommit = await run(["rev-parse", "HEAD"]);
	const numstat = await run(["diff", "--numstat", "--no-renames", binding.baseCommit, headCommit]);
	let files = 0;
	let insertions = 0;
	let deletions = 0;
	for (const line of numstat.split("\n")) {
		const [added, removed] = line.split("\t");
		if (added === undefined || removed === undefined) continue;
		files += 1;
		insertions += Number.parseInt(added, 10) || 0;
		deletions += Number.parseInt(removed, 10) || 0;
	}
	return {
		repo: binding.repo,
		baseCommit: binding.baseCommit,
		branch: binding.branch,
		headCommit,
		diffStat: { files, insertions, deletions },
	};
}

export interface PublishPullRequestOptions {
	/** Open the pull request as a draft. Default false. */
	readonly draft?: boolean;
	readonly signal?: AbortSignal;
}

export interface PublishedPullRequest {
	readonly url: string;
	readonly draft: boolean;
	/** False when an open pull request for the branch already existed and was returned instead. */
	readonly created: boolean;
}

interface ProcessResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly status: number;
}

/** The GitHub CLI command `publishPullRequest` runs: an executable and leading arguments. */
export interface WorkspaceGhCommand {
	readonly path: string;
	readonly args: readonly string[];
}

let ghCommand: WorkspaceGhCommand = { path: "gh", args: [] };

/** Internal seam: replace the GitHub CLI command. Returns a function that restores the previous one. */
export function setWorkspaceGhCommand(command: WorkspaceGhCommand): () => void {
	const previous = ghCommand;
	ghCommand = command;
	return () => {
		ghCommand = previous;
	};
}

function runGh(
	args: readonly string[],
	cwd: string,
	signal: AbortSignal | undefined,
	fields: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
	signal?.throwIfAborted();
	return new Promise((resolvePromise, reject) => {
		const child = spawn(ghCommand.path, [...ghCommand.args, ...args], {
			cwd,
			env: createChildProcessEnvironment({ GH_PROMPT_DISABLED: "1" }),
			stdio: ["ignore", "pipe", "pipe"],
			signal,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error: Error & { readonly code?: string }) => {
			if (signal?.aborted === true) reject(signal.reason);
			else if (error.code === "ENOENT")
				reject(new WorkspacePublicationError({ reason: "gh-unavailable", fields, cause: error }));
			else reject(new WorkspacePublicationError({ reason: "gh-failed", fields, cause: error }));
		});
		child.on("close", (code) => {
			if (signal?.aborted === true) return;
			resolvePromise({
				stdout: Buffer.concat(stdout).toString("utf-8"),
				stderr: Buffer.concat(stderr).toString("utf-8"),
				status: code ?? -1,
			});
		});
	});
}

function ghFailure(result: ProcessResult, fields: Readonly<Record<string, string>>): WorkspacePublicationError {
	return new WorkspacePublicationError({
		reason: "gh-failed",
		fields: { ...fields, detail: redactCredentials(result.stderr.trim() || result.stdout.trim()).slice(0, 400) },
	});
}

function parsePullRequests(
	result: ProcessResult,
	fields: Readonly<Record<string, string>>,
): readonly { readonly url: string; readonly isDraft: boolean }[] {
	try {
		return JSON.parse(result.stdout || "[]") as readonly { readonly url: string; readonly isDraft: boolean }[];
	} catch (cause) {
		throw new WorkspacePublicationError({
			reason: "gh-failed",
			fields: { ...fields, detail: "unreadable gh output" },
			cause,
		});
	}
}

/** `host/owner/repo` of a GitHub remote, the form `gh --repo` accepts. */
function ghRepository(url: string): string | undefined {
	const remote = classifyRepository(url);
	if (remote?.kind !== "remote" || remote.segments.length < 2) return undefined;
	return [remote.host, ...remote.segments.slice(-2)].join("/");
}

/**
 * Push a change set's head commit to its branch on `origin` and open a pull request for it with the GitHub CLI,
 * titled and described from its commits. An open pull request that already exists for the branch is returned instead
 * of opening a second one.
 */
export async function publishPullRequest(
	changeSet: WorkspaceChangeSet,
	options: PublishPullRequestOptions = {},
): Promise<PublishedPullRequest> {
	const { signal } = options;
	const draft = options.draft === true;
	const fields = { repo: changeSet.repo, branch: changeSet.branch };
	// Every precondition is checked before the push, the first side effect.
	await assertWorkspaceGitAvailable(signal);
	const repository = await openWorkspaceRepository(changeSet.repo, signal);
	const origin = await runWorkspaceGit({
		cwd: repository.root,
		args: ["remote", "get-url", "origin"],
		phase: "push",
		allowFailure: true,
		signal,
	});
	const github = origin.status === 0 ? ghRepository(origin.stdout.trim()) : undefined;
	if (github === undefined) throw new WorkspacePublicationError({ reason: "no-remote", fields });
	const auth = await runGh(["auth", "status", "--hostname", github.split("/")[0]!], repository.root, signal, fields);
	if (auth.status !== 0) throw new WorkspacePublicationError({ reason: "gh-unauthenticated", fields });
	try {
		await runWorkspaceGit({
			cwd: repository.root,
			args: ["push", "--quiet", "origin", `${changeSet.headCommit}:refs/heads/${changeSet.branch}`],
			phase: "push",
			signal,
		});
	} catch (error) {
		if (isWorkspaceBindingError(error) && error.code === "git-failed")
			throw new WorkspacePublicationError({ reason: "push-failed", fields, cause: error });
		throw error;
	}
	const listed = await runGh(
		[
			"pr",
			"list",
			"--repo",
			github,
			"--head",
			changeSet.branch,
			"--state",
			"open",
			"--json",
			"url,isDraft",
			"--limit",
			"1",
		],
		repository.root,
		signal,
		fields,
	);
	if (listed.status !== 0) throw ghFailure(listed, fields);
	const existing = parsePullRequests(listed, fields)[0];
	if (existing !== undefined) return { url: existing.url, draft: existing.isDraft, created: false };
	const created = await runGh(
		["pr", "create", "--repo", github, "--head", changeSet.branch, "--fill", ...(draft ? ["--draft"] : [])],
		repository.root,
		signal,
		fields,
	);
	if (created.status !== 0) throw ghFailure(created, fields);
	const url = created.stdout.trim().split("\n").at(-1) ?? "";
	return { url, draft, created: true };
}
