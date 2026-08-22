import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

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
export const RELEASE_TOOL_TIMEOUT_BUFFER_MS = 60_000;

export type PullRequestIdentity = {
	readonly url: string;
	readonly number: number;
	readonly headSha: string;
};

export type PreparationInspection =
	| { readonly mode: "prepare"; readonly summary: string }
	| {
			readonly mode: "reuse";
			readonly summary: string;
			readonly changedFiles: readonly string[];
			readonly pullRequest: PullRequestIdentity;
	  };

export type PreparationReuseState = {
	readonly baseSha: string;
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
	if (state.localSha !== undefined && state.remoteSha === undefined) {
		throw new Error(`local ${release.branch} exists without an exact remote branch and cannot be reused safely`);
	}
	if (state.localSha !== undefined && state.localSha !== state.remoteSha) {
		throw new Error(`local ${release.branch} is ${state.localSha}, expected remote ${state.remoteSha}`);
	}
	if (state.remoteSha === undefined && state.pullRequests.length === 0) {
		return {
			mode: "prepare",
			summary: `No existing ${release.branch} branch or open PR; prepare from ${state.baseSha}.`,
		};
	}
	if (state.remoteSha === undefined || state.pullRequests.length !== 1) {
		throw new Error(
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
		throw new Error(`open PR identity conflicts with ${release.branch} at ${state.remoteSha}`);
	}
	const commit = state.commit;
	if (
		commit === undefined ||
		commit.sha !== state.remoteSha ||
		commit.parents.length !== 1 ||
		commit.parents[0] !== state.baseSha
	) {
		throw new Error(
			`release commit ${state.remoteSha} is not exactly one commit atop origin/${baseRef} ${state.baseSha}`,
		);
	}
	if (commit.changedFiles.length === 0 || commit.changedFiles.some((file) => !/(^|\/)CHANGELOG\.md$/u.test(file))) {
		throw new Error(
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

function abortError(): Error {
	return new DOMException("The operation was aborted", "AbortError");
}

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
	const startedAt = clock.now();
	for (;;) {
		if (input.signal.aborted) throw input.signal.reason ?? abortError();
		const result = evaluateRequiredChecks(await input.inspect(input.signal), input.expected);
		if (result.status !== "pending") return result;
		if (clock.now() - startedAt >= timeoutMs) {
			return { status: "failed", summary: `Required CI timed out after ${timeoutMs} ms: ${result.summary}` };
		}
		await clock.sleep(Math.min(intervalMs, timeoutMs - (clock.now() - startedAt)), input.signal);
	}
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
		if (run.workflowName !== "Publish" || run.displayTitle !== `Publish ${expected.release.version}`) {
			return { status: "failed", summary: `Publish workflow identity drifted for run ${run.id}.` };
		}
		if (run.event !== "push")
			return { status: "failed", summary: `Publish run ${run.id} event drifted to ${run.event}.` };
		if (run.headSha !== expected.releaseSha)
			return { status: "failed", summary: `Publish run ${run.id} SHA drifted to ${run.headSha}.` };
	}
	const exact = [...taggedRuns].sort((left, right) => right.id - left.id)[0];
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
	const startedAt = clock.now();
	for (;;) {
		if (input.signal.aborted) throw input.signal.reason ?? abortError();
		const result = evaluatePublishRuns(await input.inspect(input.signal), input.expected);
		if (result.status !== "pending") return result;
		if (clock.now() - startedAt >= timeoutMs) {
			return { status: "failed", summary: `Publish action timed out after ${timeoutMs} ms: ${result.summary}` };
		}
		await clock.sleep(Math.min(intervalMs, timeoutMs - (clock.now() - startedAt)), input.signal);
	}
}

type CommandResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

class ReleaseCommandError extends Error {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;

	constructor(command: readonly string[], result: CommandResult) {
		super(`${command.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
		this.name = "ReleaseCommandError";
		this.exitCode = result.exitCode;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
	}
}

async function runCommand(argv: readonly string[], cwd: string, signal: AbortSignal): Promise<CommandResult> {
	const [command, ...args] = argv;
	if (command === undefined) throw new Error("release command must not be empty");
	return await new Promise<CommandResult>((resolve, reject) => {
		const child = spawn(command, args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		child.once("error", reject);
		child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
	});
}

async function checkedCommand(argv: readonly string[], cwd: string, signal: AbortSignal): Promise<string> {
	const result = await runCommand(argv, cwd, signal);
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
	readonly head: { readonly ref: string; readonly sha: string };
};

type ApiCommit = {
	readonly sha: string;
	readonly parents: readonly { readonly sha: string }[];
	readonly files?: readonly { readonly filename: string }[];
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

async function ghJson<T>(endpoint: string, cwd: string, signal: AbortSignal): Promise<T> {
	return parseJson<T>(await checkedCommand(["gh", "api", endpoint], cwd, signal));
}

async function optionalGhJson<T>(endpoint: string, cwd: string, signal: AbortSignal): Promise<T | undefined> {
	const command = ["gh", "api", endpoint] as const;
	const result = await runCommand(command, cwd, signal);
	if (result.exitCode === 0) return parseJson<T>(result.stdout);
	if (/HTTP 404|Not Found/u.test(`${result.stderr}\n${result.stdout}`)) return undefined;
	throw new ReleaseCommandError(command, result);
}

async function inspectPreparation(input: {
	readonly cwd: string;
	readonly release: ValidatedRelease;
	readonly baseRef: string;
	readonly signal: AbortSignal;
}): Promise<PreparationInspection> {
	const remoteBranch = await checkedCommand(
		["git", "ls-remote", "--heads", "origin", `refs/heads/${input.release.branch}`],
		input.cwd,
		input.signal,
	);
	const remoteBase = await checkedCommand(
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

	const localBranch = await runCommand(
		["git", "show-ref", "--verify", `refs/heads/${input.release.branch}`],
		input.cwd,
		input.signal,
	);
	if (localBranch.exitCode !== 0 && localBranch.exitCode !== 1) {
		throw new ReleaseCommandError(["git", "show-ref", "--verify", `refs/heads/${input.release.branch}`], localBranch);
	}
	const localSha = localBranch.exitCode === 0 ? localBranch.stdout.split(/\s+/u)[0] : undefined;

	const owner = "bastani-inc";
	const pulls = await ghJson<readonly ApiPullRequest[]>(
		`repos/${RELEASE_REPOSITORY}/pulls?state=open&head=${encoded(`${owner}:${input.release.branch}`)}&per_page=100`,
		input.cwd,
		input.signal,
	);
	const commit =
		remoteSha === undefined
			? undefined
			: await ghJson<ApiCommit>(`repos/${RELEASE_REPOSITORY}/commits/${remoteSha}`, input.cwd, input.signal);
	return evaluatePreparationReuse(input.release, input.baseRef, {
		baseSha,
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
						changedFiles: (commit.files ?? []).map((file) => file.filename),
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

async function configuredChecks(baseRef: string, cwd: string, signal: AbortSignal): Promise<readonly RequiredCheck[]> {
	const protection = await optionalGhJson<ProtectionResponse>(
		`repos/${RELEASE_REPOSITORY}/branches/${encoded(baseRef)}/protection/required_status_checks`,
		cwd,
		signal,
	);
	const rules = await optionalGhJson<readonly Rule[]>(
		`repos/${RELEASE_REPOSITORY}/rules/branches/${encoded(baseRef)}`,
		cwd,
		signal,
	);
	return collectConfiguredRequiredChecks(protection, rules);
}

async function requiredChecksSnapshot(input: {
	readonly cwd: string;
	readonly release: ValidatedRelease;
	readonly baseRef: string;
	readonly pullRequest: PullRequestIdentity;
	readonly signal: AbortSignal;
}): Promise<RequiredChecksSnapshot> {
	const pull = await ghJson<ApiPullRequest>(
		`repos/${RELEASE_REPOSITORY}/pulls/${input.pullRequest.number}`,
		input.cwd,
		input.signal,
	);
	const [required, checkRuns, statuses] = await Promise.all([
		configuredChecks(input.baseRef, input.cwd, input.signal),
		ghJson<CheckRunsResponse>(
			`repos/${RELEASE_REPOSITORY}/commits/${input.pullRequest.headSha}/check-runs?per_page=100`,
			input.cwd,
			input.signal,
		),
		ghJson<CommitStatusResponse>(
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

async function publishRuns(cwd: string, signal: AbortSignal): Promise<readonly PublishRun[]> {
	const response = await ghJson<WorkflowRunsResponse>(
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

export function createReleaseBoundary(cwd: string): ReleaseBoundary {
	return {
		inspectPreparation,
		waitForRequiredChecks: async (input) =>
			await pollRequiredChecks({
				expected: { release: input.release, baseRef: input.baseRef, pullRequest: input.pullRequest },
				inspect: async (signal) => await requiredChecksSnapshot({ ...input, cwd, signal }),
				signal: input.signal,
			}),
		waitForPublish: async (input) =>
			await pollPublish({
				expected: { release: input.release, releaseSha: input.releaseSha },
				inspect: async (signal) => await publishRuns(cwd, signal),
				signal: input.signal,
			}),
	};
}
