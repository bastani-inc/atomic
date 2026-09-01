import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "../../core/extensions/index.ts";
import type { FeedbackPostHandler, FeedbackPostRequest, FeedbackPostResult } from "./preview.js";
import { rescrubFeedbackDraft, type ScrubbedFeedbackDraft } from "./privacy.js";
import { FEEDBACK_REPOSITORY, type FeedbackKind, type FormattedFeedbackDraft } from "./templates.js";

const FEEDBACK_ISSUE_URL = /^https:\/\/github\.com\/bastani-inc\/atomic\/issues\/[1-9]\d*$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MARKER_SOURCE = "<!-- atomic-feedback-request:([A-Za-z0-9._:-]{1,128});kind:(bug|enhancement) -->";
const MARKER = new RegExp(MARKER_SOURCE, "gu");

export interface FeedbackTemporaryBodyFile {
	path: string;
	remove(): Promise<void>;
}

export interface FeedbackPostingDependencies {
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	fetch?: typeof globalThis.fetch;
	env?: Readonly<Record<string, string | undefined>>;
	writeBodyFile?: (body: string) => Promise<FeedbackTemporaryBodyFile>;
}

interface GitHubIssueRecord {
	body?: string;
	html_url?: string;
	url?: string;
}

type FeedbackReconciliation = { status: "found"; url: string } | { status: "absent" } | { status: "unavailable" };

interface FeedbackPostingRuntime {
	dependencies: FeedbackPostingDependencies;
	fetchImplementation: typeof globalThis.fetch;
	env: Readonly<Record<string, string | undefined>>;
	bodyWriter: (body: string) => Promise<FeedbackTemporaryBodyFile>;
	uncertainRequests: Set<string>;
	successfulRequests: Map<string, string>;
	activeRequests: Map<string, Promise<FeedbackPostResult>>;
}

export function feedbackRequestMarker(requestId: string, kind: FeedbackKind): string {
	if (!REQUEST_ID.test(requestId)) throw new Error("Feedback request identifier is invalid.");
	return `<!-- atomic-feedback-request:${requestId};kind:${kind} -->`;
}

function withoutFeedbackMarkers(body: string): string {
	return body.replace(new RegExp(String.raw`(?:\n\n)?${MARKER_SOURCE}`, "gu"), "");
}

export function applyFeedbackRequestMarker(draft: FormattedFeedbackDraft, requestId: string): FormattedFeedbackDraft {
	const marker = feedbackRequestMarker(requestId, draft.kind);
	return { ...draft, body: `${withoutFeedbackMarkers(draft.body)}\n\n${marker}` };
}

export function prepareFeedbackRequestPreview(
	preview: ScrubbedFeedbackDraft,
	requestId: string,
): ScrubbedFeedbackDraft {
	const markerSuffix = `\n\n${feedbackRequestMarker(requestId, preview.draft.kind)}`;
	return rescrubFeedbackDraft(
		{ ...preview.draft, body: withoutFeedbackMarkers(preview.draft.body) },
		preview.replacements,
		{ bodySuffix: markerSuffix },
	);
}

function validatedIssueUrl(value: string | undefined): string | undefined {
	const candidate = value?.trim();
	return candidate && FEEDBACK_ISSUE_URL.test(candidate) ? candidate : undefined;
}

function requestMarker(request: FeedbackPostRequest): string | undefined {
	if (request.draft.repository !== FEEDBACK_REPOSITORY || request.draft.label !== request.draft.kind) return undefined;
	const expected = feedbackRequestMarker(request.requestId, request.draft.kind);
	const matches = [...request.draft.body.matchAll(MARKER)];
	return matches.length === 1 && matches[0]?.[0] === expected && request.draft.body.endsWith(expected)
		? expected
		: undefined;
}

async function writeTemporaryBody(body: string): Promise<FeedbackTemporaryBodyFile> {
	const directory = await mkdtemp(join(tmpdir(), "atomic-feedback-"));
	const path = join(directory, "body.md");
	await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
	return { path, remove: async () => await rm(directory, { recursive: true, force: true }) };
}

function issueRecords(value: string): GitHubIssueRecord[] | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return undefined;
		return parsed.filter((entry): entry is GitHubIssueRecord => typeof entry === "object" && entry !== null);
	} catch {
		return undefined;
	}
}

function reconciledUrl(records: readonly GitHubIssueRecord[], marker: string): string | undefined {
	for (const issue of records) {
		if (typeof issue.body !== "string" || !issue.body.includes(marker)) continue;
		const url = validatedIssueUrl(issue.html_url ?? issue.url);
		if (url) return url;
	}
	return undefined;
}

function retained(message: string): FeedbackPostResult {
	return { status: "failure", message: `${message} The complete reviewed draft is retained.` };
}

function uncertain(): FeedbackPostResult {
	return {
		status: "uncertain",
		message:
			"GitHub did not confirm whether the issue was created. Atomic will reconcile this request before Retry. The complete reviewed draft is retained.",
	};
}

function restFailure(response: Response): FeedbackPostResult {
	if (response.status === 401)
		return retained("GitHub authentication failed. Check GH_TOKEN or GITHUB_TOKEN, then Retry.");
	if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
		return retained("GitHub rate limited the request. Wait for the limit to reset, then Retry.");
	}
	if (response.status === 403) return retained("GitHub denied permission to create the issue.");
	if (response.status === 422) return retained("GitHub rejected the issue title or body.");
	return response.status >= 500 ? uncertain() : retained("GitHub rejected the issue request.");
}

function selectToken(env: Readonly<Record<string, string | undefined>>): string | undefined {
	return env.GH_TOKEN || env.GITHUB_TOKEN || undefined;
}

async function parseRestIssue(response: Response): Promise<GitHubIssueRecord | undefined> {
	try {
		const value: unknown = await response.json();
		return typeof value === "object" && value !== null ? (value as GitHubIssueRecord) : undefined;
	} catch {
		return undefined;
	}
}

async function reconcileWithGh(runtime: FeedbackPostingRuntime, marker: string): Promise<FeedbackReconciliation> {
	try {
		const listed = await runtime.dependencies.exec("gh", [
			"issue",
			"list",
			"--repo",
			FEEDBACK_REPOSITORY,
			"--state",
			"all",
			"--author",
			"@me",
			"--limit",
			"100",
			"--json",
			"url,body",
		]);
		if (listed.code !== 0) return { status: "unavailable" };
		const records = issueRecords(listed.stdout);
		if (!records) return { status: "unavailable" };
		const url = reconciledUrl(records, marker);
		return url ? { status: "found", url } : { status: "absent" };
	} catch {
		return { status: "unavailable" };
	}
}

async function reconcileWithRest(
	runtime: FeedbackPostingRuntime,
	token: string,
	marker: string,
): Promise<FeedbackReconciliation> {
	try {
		const response = await runtime.fetchImplementation(
			`https://api.github.com/repos/${FEEDBACK_REPOSITORY}/issues?state=all&per_page=100`,
			{
				headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
			},
		);
		if (!response.ok) return { status: "unavailable" };
		const records = issueRecords(await response.text());
		if (!records) return { status: "unavailable" };
		const url = reconciledUrl(records, marker);
		return url ? { status: "found", url } : { status: "absent" };
	} catch {
		return { status: "unavailable" };
	}
}

async function ghIsReady(runtime: FeedbackPostingRuntime): Promise<boolean> {
	try {
		const status = await runtime.dependencies.exec("gh", ["auth", "status", "--hostname", "github.com"]);
		return status.code === 0;
	} catch {
		return false;
	}
}

function issueNumber(url: string): string | undefined {
	const separator = url.lastIndexOf("/");
	const number = separator === -1 ? "" : url.slice(separator + 1);
	return /^[1-9]\d*$/u.test(number) ? number : undefined;
}

async function bestEffortLabelWithGh(runtime: FeedbackPostingRuntime, url: string, kind: FeedbackKind): Promise<void> {
	const number = issueNumber(url);
	if (!number) return;
	try {
		await runtime.dependencies.exec("gh", [
			"issue",
			"edit",
			number,
			"--repo",
			FEEDBACK_REPOSITORY,
			"--add-label",
			kind,
		]);
	} catch {
		// Default-branch automation applies the same label when reporter tokens lack permission.
	}
}
async function bestEffortLabelWithRest(
	runtime: FeedbackPostingRuntime,
	token: string,
	url: string,
	kind: FeedbackKind,
): Promise<void> {
	const number = issueNumber(url);
	if (!number) return;
	try {
		await runtime.fetchImplementation(`https://api.github.com/repos/${FEEDBACK_REPOSITORY}/issues/${number}/labels`, {
			method: "POST",
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ labels: [kind] }),
		});
	} catch {
		// External reporters can create issues without label permission; workflow automation finishes labeling.
	}
}

function markUncertain(runtime: FeedbackPostingRuntime, requestId: string): FeedbackPostResult {
	runtime.uncertainRequests.add(requestId);
	return uncertain();
}

async function postWithGh(
	runtime: FeedbackPostingRuntime,
	request: FeedbackPostRequest,
	marker: string,
): Promise<FeedbackPostResult> {
	if (runtime.uncertainRequests.has(request.requestId)) {
		const reconciliation = await reconcileWithGh(runtime, marker);
		if (reconciliation.status === "found") {
			await bestEffortLabelWithGh(runtime, reconciliation.url, request.draft.kind);
			return { status: "success", url: reconciliation.url };
		}
		if (reconciliation.status === "unavailable") return uncertain();
	}
	const bodyFile = await runtime.bodyWriter(request.draft.body);
	try {
		const created = await runtime.dependencies.exec("gh", [
			"issue",
			"create",
			"--repo",
			FEEDBACK_REPOSITORY,
			"--title",
			request.draft.title,
			"--body-file",
			bodyFile.path,
		]);
		const url = created.code === 0 ? validatedIssueUrl(created.stdout) : undefined;
		if (!url) return markUncertain(runtime, request.requestId);
		await bestEffortLabelWithGh(runtime, url, request.draft.kind);
		return { status: "success", url };
	} catch {
		return markUncertain(runtime, request.requestId);
	} finally {
		try {
			await bodyFile.remove();
		} catch {
			// A cleanup failure cannot turn a confirmed creation into an untracked retry.
		}
	}
}

async function reconcileUncertainRest(
	runtime: FeedbackPostingRuntime,
	request: FeedbackPostRequest,
	token: string,
	marker: string,
): Promise<FeedbackPostResult | undefined> {
	if (!runtime.uncertainRequests.has(request.requestId)) return undefined;
	const reconciliation = await reconcileWithRest(runtime, token, marker);
	if (reconciliation.status === "found") {
		await bestEffortLabelWithRest(runtime, token, reconciliation.url, request.draft.kind);
		return { status: "success", url: reconciliation.url };
	}
	return reconciliation.status === "unavailable" ? uncertain() : undefined;
}

async function postWithRest(
	runtime: FeedbackPostingRuntime,
	request: FeedbackPostRequest,
	marker: string,
	token: string,
): Promise<FeedbackPostResult> {
	const reconciled = await reconcileUncertainRest(runtime, request, token, marker);
	if (reconciled) return reconciled;
	try {
		const response = await runtime.fetchImplementation(`https://api.github.com/repos/${FEEDBACK_REPOSITORY}/issues`, {
			method: "POST",
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ title: request.draft.title, body: request.draft.body }),
		});
		if (response.status !== 201) {
			const failure = restFailure(response);
			return failure.status === "uncertain" ? markUncertain(runtime, request.requestId) : failure;
		}
		const issue = await parseRestIssue(response);
		const url = validatedIssueUrl(issue?.html_url);
		if (!url) return markUncertain(runtime, request.requestId);
		await bestEffortLabelWithRest(runtime, token, url, request.draft.kind);
		return { status: "success", url };
	} catch {
		return markUncertain(runtime, request.requestId);
	}
}

async function postRequest(runtime: FeedbackPostingRuntime, request: FeedbackPostRequest): Promise<FeedbackPostResult> {
	const marker = requestMarker(request);
	if (!marker) return retained("The feedback request marker is missing or invalid.");
	if (await ghIsReady(runtime)) return await postWithGh(runtime, request, marker);
	const token = selectToken(runtime.env);
	if (!token) {
		return retained("GitHub authentication is required. Run gh auth login or set GH_TOKEN/GITHUB_TOKEN, then Retry.");
	}
	return await postWithRest(runtime, request, marker, token);
}

function handlePost(runtime: FeedbackPostingRuntime, request: FeedbackPostRequest): Promise<FeedbackPostResult> {
	const successful = runtime.successfulRequests.get(request.requestId);
	if (successful) return Promise.resolve({ status: "success", url: successful });
	const active = runtime.activeRequests.get(request.requestId);
	if (active) return active;
	const pending = postRequest(runtime, request)
		.catch(() => retained("Issue posting failed."))
		.then((result) => {
			if (result.status === "success") runtime.successfulRequests.set(request.requestId, result.url);
			return result;
		});
	runtime.activeRequests.set(request.requestId, pending);
	void pending.then(() => runtime.activeRequests.delete(request.requestId));
	return pending;
}

export function createGitHubFeedbackPostHandler(dependencies: FeedbackPostingDependencies): FeedbackPostHandler {
	const runtime: FeedbackPostingRuntime = {
		dependencies,
		fetchImplementation: dependencies.fetch ?? globalThis.fetch,
		env: dependencies.env ?? process.env,
		bodyWriter: dependencies.writeBodyFile ?? writeTemporaryBody,
		uncertainRequests: new Set(),
		successfulRequests: new Map(),
		activeRequests: new Map(),
	};
	return (request) => handlePost(runtime, request);
}
