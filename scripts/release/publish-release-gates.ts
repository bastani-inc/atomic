import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { ReleaseBlocked } from "./cli.js";

export type ReleaseKind = "release" | "prerelease";

export type ValidatedRelease = {
	readonly kind: ReleaseKind;
	readonly version: string;
	readonly branch: string;
};

export const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const prereleaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.[1-9]\d*$/u;

export function validateReleaseRequest(kind: ReleaseKind, version: string): ValidatedRelease {
	if (version.startsWith("v")) {
		throw new Error(`target_version must not include a leading "v"; received ${version}`);
	}

	const matches = kind === "release" ? releaseVersionPattern.test(version) : prereleaseVersionPattern.test(version);
	if (!matches || version === "0.0.0") {
		const expected = kind === "release" ? "MAJOR.MINOR.PATCH" : "MAJOR.MINOR.PATCH-alpha.REVISION";
		throw new Error(`target_version ${JSON.stringify(version)} is not valid for ${kind}; expected ${expected}`);
	}

	return { kind, version, branch: `${kind}/${version}` };
}

export const RELEASE_REPOSITORY = "bastani-inc/atomic";
export const REQUIRED_CHECK_POLL_INTERVAL_MS = 30_000;
export const REQUIRED_CHECK_TIMEOUT_MS = 45 * 60_000;
export const PUBLISH_POLL_INTERVAL_MS = 30_000;
export const PUBLISH_TIMEOUT_MS = 60 * 60_000;

export type PullRequestIdentity = {
	readonly url: string;
	readonly number: number;
	readonly headSha: string;
};

export type PreparationInspection =
	| { readonly mode: "prepare"; readonly baseSha: string; readonly summary: string }
	| {
			readonly mode: "reuse";
			readonly summary: string;
			readonly changedFiles: readonly string[];
			readonly pullRequest: PullRequestIdentity;
	  };

export type PreparationReuseState = {
	readonly worktreeStatus: string;
	readonly baseSha: string;
	/** Verified merge base when the remote base has advanced past the preparation parent. */
	readonly mergeBaseSha?: string;
	readonly remoteSha?: string;
	readonly localSha?: string;
	readonly pullRequests: readonly {
		readonly url: string;
		readonly number: number;
		readonly state: string;
		readonly merged: boolean;
		readonly baseRef: string;
		readonly repository: string;
		readonly headRef: string;
		readonly headSha: string;
	}[];
	readonly commit?: {
		readonly sha: string;
		readonly parents: readonly string[];
		readonly changedFiles: readonly string[];
	};
};

export function evaluatePreparationReuse(
	release: ValidatedRelease,
	baseRef: string,
	state: PreparationReuseState,
): PreparationInspection {
	if (state.worktreeStatus !== "") {
		throw new ReleaseBlocked(`release checkout is not clean: ${state.worktreeStatus}`);
	}
	if (state.localSha !== undefined && state.remoteSha === undefined) {
		throw new ReleaseBlocked(
			`local ${release.branch} exists without an exact remote branch and cannot be reused safely`,
		);
	}
	if (state.localSha !== undefined && state.localSha !== state.remoteSha) {
		throw new ReleaseBlocked(`local ${release.branch} is ${state.localSha}, expected remote ${state.remoteSha}`);
	}
	if (state.remoteSha === undefined && state.pullRequests.length === 0) {
		return {
			mode: "prepare",
			baseSha: state.baseSha,
			summary: `No existing ${release.branch} branch or open PR; prepare from ${state.baseSha}.`,
		};
	}
	if (state.remoteSha === undefined || state.pullRequests.length !== 1) {
		throw new ReleaseBlocked(
			`release reuse requires one exact remote branch and one matching open PR; found branch=${state.remoteSha !== undefined}, PRs=${state.pullRequests.length}`,
		);
	}
	const pull = state.pullRequests[0];
	if (
		pull === undefined ||
		pull.number < 1 ||
		pull.state !== "open" ||
		pull.merged ||
		pull.baseRef !== baseRef ||
		pull.repository !== RELEASE_REPOSITORY ||
		pull.headRef !== release.branch ||
		pull.headSha !== state.remoteSha
	) {
		throw new ReleaseBlocked(`open PR identity conflicts with ${release.branch} at ${state.remoteSha}`);
	}
	const commit = state.commit;
	if (
		commit === undefined ||
		commit.sha !== state.remoteSha ||
		commit.parents.length !== 1 ||
		commit.parents[0] !== (state.mergeBaseSha ?? state.baseSha)
	) {
		throw new ReleaseBlocked(
			`release commit ${state.remoteSha} is not exactly one commit atop origin/${baseRef} ${state.baseSha}`,
		);
	}
	if (commit.changedFiles.length === 0 || commit.changedFiles.some((file) => !/(^|\/)CHANGELOG\.md$/u.test(file))) {
		throw new ReleaseBlocked(
			`release commit ${state.remoteSha} is not changelog-only: ${commit.changedFiles.join(", ") || "no files"}`,
		);
	}
	return {
		mode: "reuse",
		summary: `Reusing exact changelog-only ${release.branch} commit ${state.remoteSha} and PR #${pull.number}.`,
		changedFiles: commit.changedFiles,
		pullRequest: { url: pull.url, number: pull.number, headSha: state.remoteSha },
	};
}

export type GateResult = {
	readonly status: "passed" | "pending" | "failed";
	readonly lastObservation?: "pending";
	readonly summary: string;
	readonly evidenceUrl?: string;
};

export type RequiredCheck = {
	readonly context: string;
	readonly appId: number | null;
};

export type CheckObservation = {
	readonly context: string;
	readonly appId: number | null;
	readonly state: "pending" | "success" | "failure";
	readonly sequence: number;
	readonly url?: string;
};

export type PrSnapshot = {
	readonly number: number;
	readonly url: string;
	readonly state: "open" | "closed";
	readonly merged: boolean;
	readonly baseRef: string;
	readonly headRef: string;
	readonly headSha: string;
	readonly repository: string;
};

export type RequiredChecksSnapshot = {
	readonly pullRequest: PrSnapshot;
	readonly required: readonly RequiredCheck[];
	readonly observations: readonly CheckObservation[];
};

export type PublishRun = {
	readonly id: number;
	readonly repository: string;
	readonly workflowPath: string;
	readonly workflowName: string;
	readonly displayTitle: string;
	readonly event: string;
	readonly headBranch: string;
	readonly headSha: string;
	readonly status: string;
	readonly conclusion: string | null;
	readonly url: string;
};

export type PollClock = {
	readonly now: () => number;
	readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type ReleaseBoundary = {
	readonly inspectPreparation: (input: {
		readonly cwd: string;
		readonly release: ValidatedRelease;
		readonly baseRef: string;
		readonly signal: AbortSignal;
	}) => Promise<PreparationInspection>;
	readonly waitForRequiredChecks: (input: {
		readonly release: ValidatedRelease;
		readonly baseRef: string;
		readonly pullRequest: PullRequestIdentity;
		readonly signal: AbortSignal;
	}) => Promise<GateResult>;
	readonly waitForPublish: (input: {
		readonly release: ValidatedRelease;
		readonly releaseSha: string;
		readonly signal: AbortSignal;
	}) => Promise<GateResult>;
};

export const systemPollClock: PollClock = {
	now: () => Date.now(),
	sleep: async (milliseconds, signal) => {
		await sleep(milliseconds, undefined, { signal });
	},
};

function exactPrIdentity(
	snapshot: PrSnapshot,
	expected: {
		readonly release: ValidatedRelease;
		readonly baseRef: string;
		readonly pullRequest: PullRequestIdentity;
	},
): string | undefined {
	if (snapshot.repository !== RELEASE_REPOSITORY) return `PR repository drifted to ${snapshot.repository}`;
	if (snapshot.number !== expected.pullRequest.number) return `PR number drifted to ${snapshot.number}`;
	if (snapshot.url !== expected.pullRequest.url) return `PR URL drifted to ${snapshot.url}`;
	if (snapshot.baseRef !== expected.baseRef) return `PR base drifted to ${snapshot.baseRef}`;
	if (snapshot.headRef !== expected.release.branch) return `PR head branch drifted to ${snapshot.headRef}`;
	if (snapshot.headSha !== expected.pullRequest.headSha) return `PR head SHA drifted to ${snapshot.headSha}`;
	return undefined;
}

export function evaluateRequiredChecks(
	snapshot: RequiredChecksSnapshot,
	expected: {
		readonly release: ValidatedRelease;
		readonly baseRef: string;
		readonly pullRequest: PullRequestIdentity;
	},
): GateResult {
	const drift = exactPrIdentity(snapshot.pullRequest, expected);
	if (drift !== undefined) return { status: "failed", summary: drift };
	if (snapshot.required.length === 0) {
		return { status: "failed", summary: `Required-check protection for ${expected.baseRef} is empty.` };
	}
	if (snapshot.pullRequest.merged) {
		return {
			status: "passed",
			summary: `Exact PR #${snapshot.pullRequest.number} was admin-merged at ${snapshot.pullRequest.headSha}.`,
			evidenceUrl: snapshot.pullRequest.url,
		};
	}
	if (snapshot.pullRequest.state !== "open") {
		return { status: "failed", summary: `Exact PR #${snapshot.pullRequest.number} closed without merge.` };
	}

	const pending: string[] = [];
	for (const required of snapshot.required) {
		const matches = snapshot.observations
			.filter(
				(observation) =>
					observation.context === required.context &&
					(required.appId === null || observation.appId === required.appId),
			)
			.sort((left, right) => right.sequence - left.sequence);
		const latest = matches[0];
		const identity = required.appId === null ? required.context : `${required.context} (app ${required.appId})`;
		if (latest === undefined || latest.state === "pending") {
			pending.push(identity);
			continue;
		}
		if (latest.state === "failure") {
			return {
				status: "failed",
				summary: `Required check ${identity} reached a terminal failure.`,
				evidenceUrl: latest.url,
			};
		}
	}
	if (pending.length > 0) {
		return { status: "pending", summary: `Required checks pending or not yet created: ${pending.join(", ")}.` };
	}
	return {
		status: "passed",
		summary: `All ${snapshot.required.length} configured required checks passed for ${expected.pullRequest.headSha}.`,
		evidenceUrl: expected.pullRequest.url,
	};
}

async function pollGate(
	label: string,
	inspect: () => Promise<GateResult>,
	signal: AbortSignal,
	clock: PollClock,
	timeoutMs: number,
	intervalMs: number,
): Promise<GateResult> {
	const startedAt = clock.now();
	let pending: GateResult | undefined;
	try {
		for (;;) {
			signal.throwIfAborted();
			const result = await inspect();
			if (result.status === "failed") return result;
			signal.throwIfAborted();
			if (result.status !== "pending") return result;
			pending = result;
			const remaining = timeoutMs - (clock.now() - startedAt);
			if (remaining <= 0) break;
			// Waking at the deadline still gets one inspection before a pending result times out.
			await clock.sleep(Math.min(intervalMs, remaining), signal);
		}
	} catch (error) {
		// The hard CLI deadline also cancels a GitHub read or sleep. Retain the last
		// complete observation, but never turn an auth/transport/operator error into pending.
		if (
			!signal.aborted ||
			signal.reason?.name !== "TimeoutError" ||
			(error !== signal.reason && !(error instanceof Error && error.name === "AbortError"))
		)
			throw error;
	}
	return {
		status: "failed",
		...(pending ? { lastObservation: "pending" as const } : {}),
		summary: `${label} timed out after ${timeoutMs} ms: ${pending?.summary ?? "No complete observation."}`,
	};
}

export async function pollRequiredChecks(input: {
	readonly inspect: (signal: AbortSignal) => Promise<RequiredChecksSnapshot>;
	readonly expected: {
		readonly release: ValidatedRelease;
		readonly baseRef: string;
		readonly pullRequest: PullRequestIdentity;
	};
	readonly signal: AbortSignal;
	readonly timeoutMs?: number;
	readonly intervalMs?: number;
	readonly clock?: PollClock;
}): Promise<GateResult> {
	const clock = input.clock ?? systemPollClock;
	const timeoutMs = input.timeoutMs ?? REQUIRED_CHECK_TIMEOUT_MS;
	const intervalMs = input.intervalMs ?? REQUIRED_CHECK_POLL_INTERVAL_MS;
	return pollGate(
		"Required CI",
		async () => evaluateRequiredChecks(await input.inspect(input.signal), input.expected),
		input.signal,
		clock,
		timeoutMs,
		intervalMs,
	);
}

export function evaluatePublishRuns(
	runs: readonly PublishRun[],
	expected: { readonly release: ValidatedRelease; readonly releaseSha: string },
): GateResult {
	const taggedRuns = runs.filter((run) => run.headBranch === expected.release.version);
	for (const run of taggedRuns) {
		if (run.repository !== RELEASE_REPOSITORY)
			return { status: "failed", summary: `Publish repository drifted to ${run.repository}.` };
		if (run.workflowPath !== ".github/workflows/publish.yml") {
			return { status: "failed", summary: `Publish workflow path drifted to ${run.workflowPath}.` };
		}
		const workflowIdentity = `Publish ${expected.release.version}`;
		if (run.workflowName !== workflowIdentity || run.displayTitle !== workflowIdentity) {
			return { status: "failed", summary: `Publish workflow identity drifted for run ${run.id}.` };
		}
		if (run.event !== "push")
			return { status: "failed", summary: `Publish run ${run.id} event drifted to ${run.event}.` };
		if (run.headSha !== expected.releaseSha)
			return { status: "failed", summary: `Publish run ${run.id} SHA drifted to ${run.headSha}.` };
	}
	if (taggedRuns.length > 1) {
		return {
			status: "failed",
			summary: `Multiple publish runs materialized for ${expected.release.version}: ${taggedRuns.map((run) => run.id).join(", ")}.`,
		};
	}
	const exact = taggedRuns[0];
	if (exact === undefined)
		return { status: "pending", summary: `Publish ${expected.release.version} has not materialized.` };
	if (exact.status !== "completed")
		return { status: "pending", summary: `Publish run ${exact.id} is ${exact.status}.`, evidenceUrl: exact.url };
	if (exact.conclusion !== "success") {
		return {
			status: "failed",
			summary: `Publish run ${exact.id} completed with ${exact.conclusion ?? "no conclusion"}.`,
			evidenceUrl: exact.url,
		};
	}
	return { status: "passed", summary: `Publish run ${exact.id} completed successfully.`, evidenceUrl: exact.url };
}

export async function pollPublish(input: {
	readonly inspect: (signal: AbortSignal) => Promise<readonly PublishRun[]>;
	readonly expected: { readonly release: ValidatedRelease; readonly releaseSha: string };
	readonly signal: AbortSignal;
	readonly timeoutMs?: number;
	readonly intervalMs?: number;
	readonly clock?: PollClock;
}): Promise<GateResult> {
	const clock = input.clock ?? systemPollClock;
	const timeoutMs = input.timeoutMs ?? PUBLISH_TIMEOUT_MS;
	const intervalMs = input.intervalMs ?? PUBLISH_POLL_INTERVAL_MS;
	return pollGate(
		"Publish action",
		async () => evaluatePublishRuns(await input.inspect(input.signal), input.expected),
		input.signal,
		clock,
		timeoutMs,
		intervalMs,
	);
}

export type ReleaseCommandResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export type ReleaseCommandTransport = {
	readonly run: (argv: readonly string[], cwd: string, signal: AbortSignal) => Promise<ReleaseCommandResult>;
};

class ReleaseCommandError extends Error {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;

	constructor(command: readonly string[], result: ReleaseCommandResult) {
		super(`${command.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
		this.name = "ReleaseCommandError";
		this.exitCode = result.exitCode;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
	}
}

async function systemRunCommand(
	argv: readonly string[],
	cwd: string,
	signal: AbortSignal,
): Promise<ReleaseCommandResult> {
	const [command, ...args] = argv;
	if (command === undefined) throw new Error("release command must not be empty");
	return await new Promise<ReleaseCommandResult>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			signal,
			// updateWorktree defers cancellation until Git is finished. Do not let a
			// terminal signal to the CLI's process group interrupt checkout mid-write.
			detached: command === "git" && (args[0] === "switch" || args[0] === "pull"),
			windowsHide: true,
			env: createGitEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.once("error", reject);
		child.once("close", (code) =>
			resolve({ exitCode: code ?? -1, stdout: args.includes("-z") ? stdout : stdout.trim(), stderr: stderr.trim() }),
		);
	});
}

const systemReleaseCommandTransport: ReleaseCommandTransport = { run: systemRunCommand };

async function checkedCommand(
	transport: ReleaseCommandTransport,
	argv: readonly string[],
	cwd: string,
	signal: AbortSignal,
): Promise<string> {
	const result = await transport.run(argv, cwd, signal);
	if (result.exitCode !== 0) throw new ReleaseCommandError(argv, result);
	return result.stdout;
}

function parseJson<T>(text: string): T {
	return JSON.parse(text) as T;
}

function encoded(value: string): string {
	return encodeURIComponent(value).replaceAll("%2F", "%2F");
}

type ApiPullRequest = {
	readonly number: number;
	readonly html_url: string;
	readonly state: string;
	readonly merged: boolean;
	readonly base: { readonly ref: string; readonly repo: { readonly full_name: string } };
	readonly head: { readonly ref: string; readonly sha: string; readonly repo: { readonly full_name: string } | null };
	readonly merge_commit_sha: string | null;
};

type ApiCommit = {
	readonly sha: string;
	readonly parents: readonly { readonly sha: string }[];
	readonly files?: readonly {
		readonly filename: string;
		readonly previous_filename?: string;
	}[];
};
export type ProtectionResponse = {
	readonly contexts?: readonly string[];
	readonly checks?: readonly { readonly context: string; readonly app_id?: number | null }[];
};
export type Rule = {
	readonly type: string;
	readonly parameters?: {
		readonly required_status_checks?: readonly {
			readonly context: string;
			readonly integration_id?: number | null;
		}[];
	};
};
type CheckRunsResponse = {
	readonly check_runs: readonly {
		readonly id: number;
		readonly name: string;
		readonly status: string;
		readonly conclusion: string | null;
		readonly html_url?: string;
		readonly app: { readonly id: number };
	}[];
};
type CommitStatusResponse = {
	readonly statuses: readonly {
		readonly id: number;
		readonly context: string;
		readonly state: string;
		readonly target_url?: string;
	}[];
};
type WorkflowRunsResponse = {
	readonly workflow_runs: readonly {
		readonly id: number;
		readonly name: string;
		readonly display_title: string;
		readonly path: string;
		readonly event: string;
		readonly head_branch: string;
		readonly head_sha: string;
		readonly status: string;
		readonly conclusion: string | null;
		readonly html_url: string;
		readonly repository: { readonly full_name: string };
	}[];
};

async function ghJson<T>(
	transport: ReleaseCommandTransport,
	endpoint: string,
	cwd: string,
	signal: AbortSignal,
): Promise<T> {
	return parseJson<T>(await checkedCommand(transport, ["gh", "api", endpoint], cwd, signal));
}

const UNPROTECTED_BRANCH_STDOUT =
	'{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-status-checks-protection","status":"404"}';
const UNPROTECTED_BRANCH_STDERR = "gh: Branch not protected (HTTP 404)";

async function optionalClassicProtection<T>(
	transport: ReleaseCommandTransport,
	endpoint: string,
	cwd: string,
	signal: AbortSignal,
): Promise<T | undefined> {
	const command = ["gh", "api", endpoint] as const;
	const result = await transport.run(command, cwd, signal);
	if (result.exitCode === 0) return parseJson<T>(result.stdout);
	if (
		result.exitCode === 1 &&
		result.stdout === UNPROTECTED_BRANCH_STDOUT &&
		result.stderr === UNPROTECTED_BRANCH_STDERR
	)
		return undefined;
	throw new ReleaseCommandError(command, result);
}

async function inspectPreparation(input: {
	readonly transport: ReleaseCommandTransport;
	readonly cwd: string;
	readonly release: ValidatedRelease;
	readonly baseRef: string;
	readonly signal: AbortSignal;
}): Promise<PreparationInspection> {
	const worktreeStatus = await checkedCommand(
		input.transport,
		["git", "status", "--porcelain=v1", "--untracked-files=all"],
		input.cwd,
		input.signal,
	);
	if (worktreeStatus !== "") throw new ReleaseBlocked(`release checkout is not clean: ${worktreeStatus}`);
	if (
		input.baseRef !== "main" &&
		(await configuredChecks(input.transport, input.baseRef, input.cwd, input.signal)).length === 0
	) {
		throw new ReleaseBlocked(`Required-check protection for ${input.baseRef} is empty.`);
	}
	const remoteBranch = await checkedCommand(
		input.transport,
		["git", "ls-remote", "--heads", "origin", `refs/heads/${input.release.branch}`],
		input.cwd,
		input.signal,
	);
	const remoteBase = await checkedCommand(
		input.transport,
		["git", "ls-remote", "--heads", "origin", `refs/heads/${input.baseRef}`],
		input.cwd,
		input.signal,
	);
	const baseSha = remoteBase.split(/\s+/u)[0];
	if (baseSha === undefined || !/^[0-9a-f]{40}$/u.test(baseSha))
		throw new Error(`origin/${input.baseRef} did not resolve exactly`);
	const remoteSha = remoteBranch === "" ? undefined : remoteBranch.split(/\s+/u)[0];
	if (remoteSha !== undefined && !/^[0-9a-f]{40}$/u.test(remoteSha))
		throw new Error(`${input.release.branch} remote identity is malformed`);

	const localRef = `refs/heads/${input.release.branch}`;
	const localRefCommand = ["git", "rev-parse", "--verify", "--quiet", "--end-of-options", localRef] as const;
	const localBranch = await input.transport.run(localRefCommand, input.cwd, input.signal);
	if (localBranch.exitCode !== 0 && localBranch.exitCode !== 1) {
		throw new ReleaseCommandError(localRefCommand, localBranch);
	}
	const localSha = localBranch.exitCode === 0 ? localBranch.stdout.split(/\s+/u)[0] : undefined;

	const owner = "bastani-inc";
	const pulls = await ghJson<readonly ApiPullRequest[]>(
		input.transport,
		`repos/${RELEASE_REPOSITORY}/pulls?state=open&head=${encoded(`${owner}:${input.release.branch}`)}&per_page=100`,
		input.cwd,
		input.signal,
	);
	let commit: ApiCommit | undefined;
	const changedFiles: string[] = [];
	if (remoteSha !== undefined) {
		let page = 1;
		for (;;) {
			const response = await ghJson<ApiCommit>(
				input.transport,
				`repos/${RELEASE_REPOSITORY}/commits/${remoteSha}?per_page=100&page=${page}`,
				input.cwd,
				input.signal,
			);
			commit ??= response;
			const files = response.files ?? [];
			for (const file of files) {
				changedFiles.push(file.filename);
				if (file.previous_filename !== undefined) changedFiles.push(file.previous_filename);
			}
			if (files.length < 100) break;
			page += 1;
		}
	}
	// The base can advance while CI runs, and the new tip need not exist in this checkout.
	// Compare immutable SHAs without fetching into the worktree. Only one commit unique to
	// the release branch is allowed; its sole parent must be the common ancestor.
	let mergeBaseSha: string | undefined;
	if (commit?.parents.length === 1 && commit.parents[0].sha !== baseSha && remoteSha !== undefined) {
		const comparison = await ghJson<{
			base_commit: { sha: string };
			merge_base_commit: { sha: string };
			ahead_by: number;
		}>(
			input.transport,
			`repos/${RELEASE_REPOSITORY}/compare/${baseSha}...${remoteSha}?per_page=1`,
			input.cwd,
			input.signal,
		);
		if (comparison.base_commit.sha === baseSha && comparison.ahead_by === 1)
			mergeBaseSha = comparison.merge_base_commit.sha;
	}
	return evaluatePreparationReuse(input.release, input.baseRef, {
		worktreeStatus,
		baseSha,
		mergeBaseSha,
		...(remoteSha === undefined ? {} : { remoteSha }),
		...(localSha === undefined ? {} : { localSha }),
		pullRequests: pulls.map((pull) => ({
			url: pull.html_url,
			number: pull.number,
			state: pull.state,
			merged: pull.merged,
			baseRef: pull.base.ref,
			repository: pull.base.repo.full_name,
			headRef: pull.head.ref,
			headSha: pull.head.sha,
		})),
		...(commit === undefined
			? {}
			: {
					commit: {
						sha: commit.sha,
						parents: commit.parents.map((parent) => parent.sha),
						changedFiles,
					},
				}),
	});
}

export function collectConfiguredRequiredChecks(
	protection: ProtectionResponse | undefined,
	rules: readonly Rule[] | undefined,
): readonly RequiredCheck[] {
	const required: RequiredCheck[] = [];
	for (const context of protection?.contexts ?? []) required.push({ context, appId: null });
	for (const check of protection?.checks ?? []) required.push({ context: check.context, appId: check.app_id ?? null });
	for (const rule of rules ?? []) {
		if (rule.type !== "required_status_checks") continue;
		for (const check of rule.parameters?.required_status_checks ?? []) {
			required.push({ context: check.context, appId: check.integration_id ?? null });
		}
	}
	return required;
}

async function configuredChecks(
	transport: ReleaseCommandTransport,
	baseRef: string,
	cwd: string,
	signal: AbortSignal,
): Promise<readonly RequiredCheck[]> {
	const protection = await optionalClassicProtection<ProtectionResponse>(
		transport,
		`repos/${RELEASE_REPOSITORY}/branches/${encoded(baseRef)}/protection/required_status_checks`,
		cwd,
		signal,
	);
	const rules: Rule[] = [];
	for (let page = 1; ; page += 1) {
		const rulePage = await ghJson<unknown>(
			transport,
			`repos/${RELEASE_REPOSITORY}/rules/branches/${encoded(baseRef)}?per_page=100&page=${page}`,
			cwd,
			signal,
		);
		if (!Array.isArray(rulePage)) throw new TypeError(`GitHub branch-rules page ${page} response must be an array`);
		rules.push(...(rulePage as readonly Rule[]));
		if (rulePage.length < 100) break;
	}
	return collectConfiguredRequiredChecks(protection, rules);
}

async function requiredChecksSnapshot(input: {
	readonly transport: ReleaseCommandTransport;
	readonly cwd: string;
	readonly release: ValidatedRelease;
	readonly baseRef: string;
	readonly pullRequest: PullRequestIdentity;
	readonly signal: AbortSignal;
}): Promise<RequiredChecksSnapshot> {
	const pull = await ghJson<ApiPullRequest>(
		input.transport,
		`repos/${RELEASE_REPOSITORY}/pulls/${input.pullRequest.number}`,
		input.cwd,
		input.signal,
	);
	const [required, checkRuns, statuses] = await Promise.all([
		configuredChecks(input.transport, input.baseRef, input.cwd, input.signal),
		ghJson<CheckRunsResponse>(
			input.transport,
			`repos/${RELEASE_REPOSITORY}/commits/${input.pullRequest.headSha}/check-runs?per_page=100`,
			input.cwd,
			input.signal,
		),
		ghJson<CommitStatusResponse>(
			input.transport,
			`repos/${RELEASE_REPOSITORY}/commits/${input.pullRequest.headSha}/status?per_page=100`,
			input.cwd,
			input.signal,
		),
	]);
	const observations: CheckObservation[] = checkRuns.check_runs.map((check) => ({
		context: check.name,
		appId: check.app.id,
		state: check.status !== "completed" ? "pending" : check.conclusion === "success" ? "success" : "failure",
		sequence: check.id,
		...(check.html_url === undefined ? {} : { url: check.html_url }),
	}));
	for (const status of statuses.statuses) {
		observations.push({
			context: status.context,
			appId: null,
			state: status.state === "pending" ? "pending" : status.state === "success" ? "success" : "failure",
			sequence: status.id,
			...(status.target_url === undefined ? {} : { url: status.target_url }),
		});
	}
	return {
		pullRequest: {
			number: pull.number,
			url: pull.html_url,
			state: pull.state === "open" ? "open" : "closed",
			merged: pull.merged,
			baseRef: pull.base.ref,
			headRef: pull.head.ref,
			headSha: pull.head.sha,
			repository: pull.base.repo.full_name,
		},
		required,
		observations,
	};
}

async function publishRuns(
	transport: ReleaseCommandTransport,
	cwd: string,
	signal: AbortSignal,
): Promise<readonly PublishRun[]> {
	const response = await ghJson<WorkflowRunsResponse>(
		transport,
		`repos/${RELEASE_REPOSITORY}/actions/workflows/publish.yml/runs?event=push&per_page=100`,
		cwd,
		signal,
	);
	return response.workflow_runs.map((run) => ({
		id: run.id,
		repository: run.repository.full_name,
		workflowPath: run.path,
		workflowName: run.name,
		displayTitle: run.display_title,
		event: run.event,
		headBranch: run.head_branch,
		headSha: run.head_sha,
		status: run.status,
		conclusion: run.conclusion,
		url: run.html_url,
	}));
}

export type ReleaseBoundaryOptions = {
	readonly transport?: ReleaseCommandTransport;
	readonly clock?: PollClock;
	readonly requiredCheckTimeoutMs?: number;
	readonly requiredCheckIntervalMs?: number;
	readonly publishTimeoutMs?: number;
	readonly publishIntervalMs?: number;
};

export function createReleaseBoundary(cwd: string, options: ReleaseBoundaryOptions = {}): ReleaseBoundary {
	const transport = options.transport ?? systemReleaseCommandTransport;
	return {
		inspectPreparation: async (input) => await inspectPreparation({ ...input, transport }),
		waitForRequiredChecks: async (input) =>
			await pollRequiredChecks({
				expected: { release: input.release, baseRef: input.baseRef, pullRequest: input.pullRequest },
				inspect: async (signal) => await requiredChecksSnapshot({ ...input, transport, cwd, signal }),
				signal: input.signal,
				...(options.clock === undefined ? {} : { clock: options.clock }),
				...(options.requiredCheckTimeoutMs === undefined ? {} : { timeoutMs: options.requiredCheckTimeoutMs }),
				...(options.requiredCheckIntervalMs === undefined ? {} : { intervalMs: options.requiredCheckIntervalMs }),
			}),
		waitForPublish: async (input) =>
			await pollPublish({
				expected: { release: input.release, releaseSha: input.releaseSha },
				inspect: async (signal) => await publishRuns(transport, cwd, signal),
				signal: input.signal,
				...(options.clock === undefined ? {} : { clock: options.clock }),
				...(options.publishTimeoutMs === undefined ? {} : { timeoutMs: options.publishTimeoutMs }),
				...(options.publishIntervalMs === undefined ? {} : { intervalMs: options.publishIntervalMs }),
			}),
	};
}

export async function checkChangelogDiff(cwd: string, baseRef: string, signal: AbortSignal) {
	const git = (...args: string[]) => checkedCommand(systemReleaseCommandTransport, ["git", ...args], cwd, signal);
	const [baseSha, ref] = (await git("ls-remote", "--heads", "origin", `refs/heads/${baseRef}`)).split(/\s+/u);
	if (!/^[0-9a-f]{40}$/u.test(baseSha) || ref !== `refs/heads/${baseRef}`)
		throw new ReleaseBlocked(`Cannot resolve origin/${baseRef}.`);
	// Check each side of the index separately: a working-tree revert can conceal a staged change.
	// Do not collapse renames: the source path must be a changelog too. NUL preserves unusual paths.
	const paths = (s: string) => s.split("\0").filter(Boolean);
	const files = new Set(
		(
			await Promise.all([
				git("diff", "--cached", "--no-renames", "--name-only", "-z", baseSha, "--"),
				git("diff", "--no-renames", "--name-only", "-z", "--"),
				git("ls-files", "--others", "--exclude-standard", "-z"),
			])
		).flatMap(paths),
	);
	if (!files.size || [...files].some((file) => !/(^|\/)CHANGELOG\.md$/u.test(file)))
		throw new ReleaseBlocked(`Expected a nonempty changelog-only diff: ${[...files].join(", ") || "no files"}`);
	const manifests = paths(await git("ls-files", "-z", "--", ":(glob)packages/*/package.json"));
	if (!manifests.includes("packages/coding-agent/package.json"))
		throw new ReleaseBlocked("Missing coding-agent manifest.");
	for (const path of manifests) {
		if (JSON.parse(readFileSync(join(cwd, path), "utf8")).version !== "0.0.0")
			throw new ReleaseBlocked(`Expected ${path} to remain at 0.0.0.`);
	}
	return { status: "passed", baseSha, changedFiles: [...files] };
}

/** Recheck the PR and CI here: a prior skill message is not proof that the head is still safe to merge. */
export async function mergeExactHead(
	input: {
		cwd: string;
		baseRef: string;
		pullRequest: PullRequestIdentity;
		release?: ValidatedRelease;
		dryRun: boolean;
		signal: AbortSignal;
		syncSignal?: AbortSignal;
	},
	transport = systemReleaseCommandTransport,
) {
	const { cwd, baseRef, pullRequest, signal } = input;
	const run = (...argv: string[]) => checkedCommand(transport, argv, cwd, signal);
	const clean = async (checkSignal: AbortSignal) => {
		const status = await checkedCommand(
			transport,
			["git", "status", "--porcelain=v1", "--untracked-files=all"],
			cwd,
			checkSignal,
		);
		if (status) throw new ReleaseBlocked(`release checkout is not clean: ${status}`);
	};
	await clean(signal);
	const readPr = () =>
		ghJson<ApiPullRequest>(transport, `repos/${RELEASE_REPOSITORY}/pulls/${pullRequest.number}`, cwd, signal);
	const initial = await readPr();
	const [kind, version] = initial.head.ref.split("/");
	if ((kind !== "release" && kind !== "prerelease") || !version)
		throw new ReleaseBlocked(`Not a release PR: ${initial.head.ref}`);
	const release = input.release ?? validateReleaseRequest(kind, version);
	const verify = (pr: ApiPullRequest) => {
		if (
			pr.number !== pullRequest.number ||
			pr.html_url !== pullRequest.url ||
			pr.base.repo.full_name !== RELEASE_REPOSITORY ||
			pr.head.repo?.full_name !== RELEASE_REPOSITORY ||
			pr.base.ref !== baseRef ||
			pr.head.ref !== release.branch ||
			pr.head.sha !== pullRequest.headSha ||
			(!pr.merged && pr.state !== "open")
		) {
			throw new ReleaseBlocked(
				`Expected open or merged ${pullRequest.url} from ${release.branch} at ${pullRequest.headSha} to ${baseRef}.`,
			);
		}
	};
	verify(initial);
	if (!initial.merged) {
		const preparation = await inspectPreparation({ transport, cwd, release, baseRef, signal });
		if (
			preparation.mode !== "reuse" ||
			preparation.pullRequest.number !== pullRequest.number ||
			preparation.pullRequest.url !== pullRequest.url ||
			preparation.pullRequest.headSha !== pullRequest.headSha
		)
			throw new ReleaseBlocked("No matching changelog-only preparation to merge.");
	}
	const expected = { release, baseRef, pullRequest };
	const snapshot = await requiredChecksSnapshot({ ...expected, cwd, transport, signal });
	const ci = evaluateRequiredChecks(snapshot, expected);
	if (ci.status !== "passed") throw new ReleaseBlocked(ci.summary);
	let pr = await readPr();
	verify(pr);
	if (!pr.merged && (initial.merged || snapshot.pullRequest.merged))
		throw new ReleaseBlocked("PR merged state changed during verification.");
	if (input.dryRun)
		return {
			status: "passed",
			dryRun: true,
			action: pr.merged ? "would-sync-base" : "would-merge-exact-head",
			pr: pullRequest,
			summary: ci.summary,
		};
	if (!pr.merged) {
		await run("gh", "pr", "merge", pullRequest.url, "--squash", "--match-head-commit", pullRequest.headSha);
		pr = await readPr();
		verify(pr);
	}
	if (!pr.merged || !pr.merge_commit_sha || !/^[0-9a-f]{40}$/u.test(pr.merge_commit_sha))
		throw new ReleaseBlocked("Exact head is not yet provably merged; base not synchronized.");
	// The PR is merged. A slow sync must not inherit the inspection deadline. Stop at
	// safe boundaries rather than killing a Git process while it updates the worktree.
	const syncSignal = input.syncSignal ?? signal;
	const syncGit = (...args: string[]) => checkedCommand(transport, ["git", ...args], cwd, syncSignal);
	const updateWorktree = async (...args: string[]) => {
		syncSignal.throwIfAborted();
		await checkedCommand(transport, ["git", ...args], cwd, new AbortController().signal);
		syncSignal.throwIfAborted();
	};
	await clean(syncSignal);
	await updateWorktree("switch", baseRef);
	await syncGit("fetch", "--no-tags", "origin", `refs/heads/${baseRef}`);
	await updateWorktree("pull", "--ff-only", "origin", baseRef);
	await clean(syncSignal);
	const baseSha = await syncGit("rev-parse", "HEAD");
	const remote = await syncGit("ls-remote", "--heads", "origin", `refs/heads/${baseRef}`);
	if (remote !== `${baseSha}\trefs/heads/${baseRef}` || (await syncGit("branch", "--show-current")) !== baseRef)
		throw new ReleaseBlocked(`Local HEAD does not match origin/${baseRef}.`);
	await syncGit("merge-base", "--is-ancestor", pr.merge_commit_sha, baseSha);
	return { status: "passed", baseRef, baseSha, pr: pullRequest };
}
