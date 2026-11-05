import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { WorkspacePublicationError } from "./errors.ts";
import { assertWorkspaceGitAvailable, gitOutput, runWorkspaceGit } from "./git.ts";
import { runWorkspaceProcess } from "./process.ts";
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
	// One "<added>\t<removed>\t<path>" line per file; a binary file reports "-" for both counts.
	for (const line of numstat.split("\n").filter((entry) => entry !== "")) {
		const [added = "", removed = ""] = line.split("\t");
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

/** Run gh to its end. Cancellation stops gh and everything it started, and rejects with `signal.reason` once they exited. */
async function runGh(
	args: readonly string[],
	cwd: string,
	signal: AbortSignal | undefined,
	fields: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
	signal?.throwIfAborted();
	const outcome = await runWorkspaceProcess({
		path: ghCommand.path,
		args: [...ghCommand.args, ...args],
		cwd,
		env: createChildProcessEnvironment({ GH_PROMPT_DISABLED: "1" }),
		signal,
	});
	if (outcome.kind === "not-started")
		throw new WorkspacePublicationError({
			reason: outcome.error.code === "ENOENT" ? "gh-unavailable" : "gh-failed",
			fields,
			cause: outcome.error,
		});
	return { stdout: outcome.stdout, stderr: outcome.stderr, status: outcome.status ?? -1 };
}

function processFailure(
	reason: "push-failed" | "gh-failed",
	result: ProcessResult,
	fields: Readonly<Record<string, string>>,
): WorkspacePublicationError {
	return new WorkspacePublicationError({
		reason,
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
	// Without an origin git prints nothing on stdout, which classifies as no GitHub repository.
	const github = ghRepository(origin.stdout.trim());
	if (github === undefined) throw new WorkspacePublicationError({ reason: "no-remote", fields });
	const auth = await runGh(["auth", "status", "--hostname", github.split("/")[0]!], repository.root, signal, fields);
	if (auth.status !== 0) throw new WorkspacePublicationError({ reason: "gh-unauthenticated", fields });
	const pushed = await runWorkspaceGit({
		cwd: repository.root,
		args: ["push", "origin", `${changeSet.headCommit}:refs/heads/${changeSet.branch}`],
		phase: "push",
		allowFailure: true,
		signal,
	});
	if (pushed.status !== 0) throw processFailure("push-failed", pushed, fields);
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
	if (listed.status !== 0) throw processFailure("gh-failed", listed, fields);
	const existing = parsePullRequests(listed, fields)[0];
	if (existing !== undefined) return { url: existing.url, draft: existing.isDraft, created: false };
	const created = await runGh(
		["pr", "create", "--repo", github, "--head", changeSet.branch, "--fill", ...(draft ? ["--draft"] : [])],
		repository.root,
		signal,
		fields,
	);
	if (created.status !== 0) throw processFailure("gh-failed", created, fields);
	// gh prints progress lines first and the pull request URL last.
	const url = created.stdout.trim().split("\n").at(-1) as string;
	return { url, draft, created: true };
}
