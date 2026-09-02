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

export const FEEDBACK_GH_AUTH_TIMEOUT_MS = 5_000;
export const FEEDBACK_GH_CREATE_TIMEOUT_MS = 20_000;
export const FEEDBACK_GH_RECONCILE_TIMEOUT_MS = 10_000;
export const FEEDBACK_GH_LABEL_TIMEOUT_MS = 10_000;
export const FEEDBACK_REST_CREATE_TIMEOUT_MS = 20_000;
export const FEEDBACK_REST_RECONCILE_TIMEOUT_MS = 10_000;
export const FEEDBACK_REST_LABEL_TIMEOUT_MS = 10_000;

export interface FeedbackPostingTimeouts {
	ghAuthMs: number;
	ghCreateMs: number;
	ghReconcileMs: number;
	ghLabelMs: number;
	restCreateMs: number;
	restReconcileMs: number;
	restLabelMs: number;
}

const DEFAULT_POSTING_TIMEOUTS: FeedbackPostingTimeouts = {
	ghAuthMs: FEEDBACK_GH_AUTH_TIMEOUT_MS,
	ghCreateMs: FEEDBACK_GH_CREATE_TIMEOUT_MS,
	ghReconcileMs: FEEDBACK_GH_RECONCILE_TIMEOUT_MS,
	ghLabelMs: FEEDBACK_GH_LABEL_TIMEOUT_MS,
	restCreateMs: FEEDBACK_REST_CREATE_TIMEOUT_MS,
	restReconcileMs: FEEDBACK_REST_RECONCILE_TIMEOUT_MS,
	restLabelMs: FEEDBACK_REST_LABEL_TIMEOUT_MS,
};

export interface FeedbackTemporaryBodyFile {
	path: string;
	remove(): Promise<void>;
}

export interface FeedbackPostingDependencies {
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	fetch?: typeof globalThis.fetch;
	env?: Readonly<Record<string, string | undefined>>;
	writeBodyFile?: (body: string) => Promise<FeedbackTemporaryBodyFile>;
	timeouts?: Partial<FeedbackPostingTimeouts>;
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
	timeouts: FeedbackPostingTimeouts;
	uncertainRequests: Set<string>;
	successfulRequests: Map<string, string>;
	activeRequests: Map<string, Promise<FeedbackPostResult>>;
}

async function runBounded<T>(
	timeoutMs: number,
	externalSignal: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	let rejectOnAbort: ((reason: Error) => void) | undefined;
	const aborted = new Promise<T>((_resolve, reject) => {
		rejectOnAbort = reject;
	});
	const onAbort = (): void => rejectOnAbort?.(new Error("GitHub feedback request was aborted or timed out."));
	const forwardAbort = (): void => controller.abort(externalSignal?.reason);
	controller.signal.addEventListener("abort", onAbort, { once: true });
	if (externalSignal?.aborted) forwardAbort();
	else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await Promise.race([run(controller.signal), aborted]);
	} finally {
		clearTimeout(timer);
		controller.signal.removeEventListener("abort", onAbort);
		externalSignal?.removeEventListener("abort", forwardAbort);
	}
}

function execGh(
	runtime: FeedbackPostingRuntime,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ExecResult> {
	return runBounded(timeoutMs, signal, (boundedSignal) =>
		runtime.dependencies.exec("gh", args, { signal: boundedSignal, timeout: timeoutMs }),
	);
}

function fetchGitHub(
	runtime: FeedbackPostingRuntime,
	input: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	return runBounded(timeoutMs, signal, async (boundedSignal) => {
		const response = await runtime.fetchImplementation(input, { ...init, signal: boundedSignal });
		await response.body?.cancel();
	});
}
interface GitHubResponseWithText {
	response: Response;
	text?: string;
}
interface GitHubTextRequest {
	input: string;
	init: RequestInit;
	timeoutMs: number;
	shouldReadBody: (response: Response) => boolean;
}

async function fetchGitHubTextWithSignal(
	runtime: FeedbackPostingRuntime,
	request: Omit<GitHubTextRequest, "timeoutMs">,
	signal: AbortSignal,
): Promise<GitHubResponseWithText> {
	const response = await runtime.fetchImplementation(request.input, { ...request.init, signal });
	if (request.shouldReadBody(response)) return { response, text: await response.text() };
	await response.body?.cancel();
	return { response };
}

function fetchGitHubWithText(
	runtime: FeedbackPostingRuntime,
	request: GitHubTextRequest,
	signal?: AbortSignal,
): Promise<GitHubResponseWithText> {
	return runBounded(request.timeoutMs, signal, (boundedSignal) =>
		fetchGitHubTextWithSignal(runtime, request, boundedSignal),
	);
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

function reconciledGhOutput(value: string, marker: string): FeedbackReconciliation {
	const trimmed = value.trim();
	if (trimmed.length === 0) return { status: "absent" };
	const legacyRecords = issueRecords(trimmed);
	if (legacyRecords) {
		const url = reconciledUrl(legacyRecords, marker);
		return url ? { status: "found", url } : { status: "absent" };
	}
	const urls = trimmed.split(/\r?\n/u);
	if (urls.some((url) => validatedIssueUrl(url) === undefined)) return { status: "unavailable" };
	return { status: "found", url: urls[0]!.trim() };
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

function parseRestIssue(text: string | undefined): GitHubIssueRecord | undefined {
	try {
		const value: unknown = JSON.parse(text ?? "");
		return typeof value === "object" && value !== null ? (value as GitHubIssueRecord) : undefined;
	} catch {
		return undefined;
	}
}

async function reconcileWithGh(
	runtime: FeedbackPostingRuntime,
	marker: string,
	signal?: AbortSignal,
): Promise<FeedbackReconciliation> {
	try {
		const listed = await execGh(
			runtime,
			[
				"api",
				"--paginate",
				"--slurp",
				"-H",
				"Accept: application/vnd.github+json",
				`repos/${FEEDBACK_REPOSITORY}/issues?state=all&per_page=100`,
				"--jq",
				`[.[][] | select(.body != null and (.body | contains(${JSON.stringify(marker)}))) | .html_url][:2][]`,
			],
			runtime.timeouts.ghReconcileMs,
			signal,
		);
		if (listed.code !== 0 || listed.killed) return { status: "unavailable" };
		return reconciledGhOutput(listed.stdout, marker);
	} catch {
		return { status: "unavailable" };
	}
}

const REST_RECONCILIATION_URL = `https://api.github.com/repos/${FEEDBACK_REPOSITORY}/issues?state=all&per_page=100`;

function validatedReconciliationPageUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (
			url.origin !== "https://api.github.com" ||
			url.username.length > 0 ||
			url.password.length > 0 ||
			url.hash.length > 0 ||
			url.pathname !== `/repos/${FEEDBACK_REPOSITORY}/issues` ||
			url.searchParams.get("state") !== "all" ||
			url.searchParams.get("per_page") !== "100"
		) {
			return undefined;
		}
		return url.toString();
	} catch {
		return undefined;
	}
}

function nextReconciliationPage(response: Response): { status: "done" } | { status: "next"; url: string } | undefined {
	const link = response.headers.get("link");
	if (!link) return { status: "done" };
	for (const part of link.split(",")) {
		const target = /^\s*<([^>]+)>/u.exec(part)?.[1];
		const relation = /;\s*rel\s*=\s*"?([^";]+)"?/iu.exec(part)?.[1]?.trim().split(/\s+/u) ?? [];
		if (!relation.includes("next")) continue;
		const url = target === undefined ? undefined : validatedReconciliationPageUrl(target);
		return url === undefined ? undefined : { status: "next", url };
	}
	return /rel\s*=\s*"?next\b/iu.test(link) ? undefined : { status: "done" };
}

async function reconcileWithRest(
	runtime: FeedbackPostingRuntime,
	token: string,
	marker: string,
	signal?: AbortSignal,
): Promise<FeedbackReconciliation> {
	try {
		return await runBounded(runtime.timeouts.restReconcileMs, signal, async (boundedSignal) => {
			let pageUrl = REST_RECONCILIATION_URL;
			const visited = new Set<string>();
			while (!visited.has(pageUrl)) {
				visited.add(pageUrl);
				const { response, text } = await fetchGitHubTextWithSignal(
					runtime,
					{
						input: pageUrl,
						init: { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` } },
						shouldReadBody: (candidate) => candidate.ok,
					},
					boundedSignal,
				);
				if (!response.ok) return { status: "unavailable" };
				const records = issueRecords(text ?? "");
				if (!records) return { status: "unavailable" };
				const url = reconciledUrl(records, marker);
				if (url) return { status: "found", url };
				const next = nextReconciliationPage(response);
				if (next === undefined || (next.status === "next" && visited.has(next.url))) {
					return { status: "unavailable" };
				}
				if (next.status === "done") return { status: "absent" };
				pageUrl = next.url;
			}
			return { status: "unavailable" };
		});
	} catch {
		return { status: "unavailable" };
	}
}

async function ghIsReady(runtime: FeedbackPostingRuntime, signal?: AbortSignal): Promise<boolean> {
	try {
		const status = await execGh(
			runtime,
			["auth", "status", "--hostname", "github.com"],
			runtime.timeouts.ghAuthMs,
			signal,
		);
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

async function bestEffortLabelWithGh(
	runtime: FeedbackPostingRuntime,
	url: string,
	kind: FeedbackKind,
	signal?: AbortSignal,
): Promise<void> {
	const number = issueNumber(url);
	if (!number) return;
	try {
		await execGh(
			runtime,
			["issue", "edit", number, "--repo", FEEDBACK_REPOSITORY, "--add-label", kind],
			runtime.timeouts.ghLabelMs,
			signal,
		);
	} catch {
		// Default-branch automation applies the same label when reporter tokens lack permission.
	}
}

async function bestEffortLabelWithRest(
	runtime: FeedbackPostingRuntime,
	token: string,
	url: string,
	kind: FeedbackKind,
	signal?: AbortSignal,
): Promise<void> {
	const number = issueNumber(url);
	if (!number) return;
	try {
		await fetchGitHub(
			runtime,
			`https://api.github.com/repos/${FEEDBACK_REPOSITORY}/issues/${number}/labels`,
			{
				method: "POST",
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ labels: [kind] }),
			},
			runtime.timeouts.restLabelMs,
			signal,
		);
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
	signal?: AbortSignal,
): Promise<FeedbackPostResult> {
	if (runtime.uncertainRequests.has(request.requestId)) {
		const reconciliation = await reconcileWithGh(runtime, marker, signal);
		if (reconciliation.status === "found") {
			await bestEffortLabelWithGh(runtime, reconciliation.url, request.draft.kind, signal);
			return { status: "success", url: reconciliation.url };
		}
		if (reconciliation.status === "unavailable") return uncertain();
	}
	const bodyFile = await runtime.bodyWriter(request.draft.body);
	try {
		const created = await execGh(
			runtime,
			[
				"issue",
				"create",
				"--repo",
				FEEDBACK_REPOSITORY,
				"--title",
				request.draft.title,
				"--body-file",
				bodyFile.path,
			],
			runtime.timeouts.ghCreateMs,
			signal,
		);
		const url = created.code === 0 ? validatedIssueUrl(created.stdout) : undefined;
		if (!url) return markUncertain(runtime, request.requestId);
		await bestEffortLabelWithGh(runtime, url, request.draft.kind, signal);
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
	signal?: AbortSignal,
): Promise<FeedbackPostResult | undefined> {
	if (!runtime.uncertainRequests.has(request.requestId)) return undefined;
	const reconciliation = await reconcileWithRest(runtime, token, marker, signal);
	if (reconciliation.status === "found") {
		await bestEffortLabelWithRest(runtime, token, reconciliation.url, request.draft.kind, signal);
		return { status: "success", url: reconciliation.url };
	}
	return reconciliation.status === "unavailable" ? uncertain() : undefined;
}

async function postWithRest(
	runtime: FeedbackPostingRuntime,
	request: FeedbackPostRequest,
	marker: string,
	token: string,
	signal?: AbortSignal,
): Promise<FeedbackPostResult> {
	const reconciled = await reconcileUncertainRest(runtime, request, token, marker, signal);
	if (reconciled) return reconciled;
	try {
		const { response, text } = await fetchGitHubWithText(
			runtime,
			{
				input: `https://api.github.com/repos/${FEEDBACK_REPOSITORY}/issues`,
				init: {
					method: "POST",
					headers: {
						accept: "application/vnd.github+json",
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ title: request.draft.title, body: request.draft.body }),
				},
				timeoutMs: runtime.timeouts.restCreateMs,
				shouldReadBody: (candidate) => candidate.status === 201,
			},
			signal,
		);
		if (response.status !== 201) {
			const failure = restFailure(response);
			return failure.status === "uncertain" ? markUncertain(runtime, request.requestId) : failure;
		}
		const issue = parseRestIssue(text);
		const url = validatedIssueUrl(issue?.html_url);
		if (!url) return markUncertain(runtime, request.requestId);
		await bestEffortLabelWithRest(runtime, token, url, request.draft.kind, signal);
		return { status: "success", url };
	} catch {
		return markUncertain(runtime, request.requestId);
	}
}

async function postRequest(
	runtime: FeedbackPostingRuntime,
	request: FeedbackPostRequest,
	signal?: AbortSignal,
): Promise<FeedbackPostResult> {
	const marker = requestMarker(request);
	if (!marker) return retained("The feedback request marker is missing or invalid.");
	if (await ghIsReady(runtime, signal)) return await postWithGh(runtime, request, marker, signal);
	const token = selectToken(runtime.env);
	if (!token && runtime.uncertainRequests.has(request.requestId)) return uncertain();
	if (!token) {
		return retained("GitHub authentication is required. Run gh auth login or set GH_TOKEN/GITHUB_TOKEN, then Retry.");
	}
	return await postWithRest(runtime, request, marker, token, signal);
}

function handlePost(
	runtime: FeedbackPostingRuntime,
	request: FeedbackPostRequest,
	signal?: AbortSignal,
): Promise<FeedbackPostResult> {
	const successful = runtime.successfulRequests.get(request.requestId);
	if (successful) return Promise.resolve({ status: "success", url: successful });
	const active = runtime.activeRequests.get(request.requestId);
	if (active) return active;
	const pending = postRequest(runtime, request, signal)
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
		timeouts: { ...DEFAULT_POSTING_TIMEOUTS, ...dependencies.timeouts },
		uncertainRequests: new Set(),
		successfulRequests: new Map(),
		activeRequests: new Map(),
	};
	return (request, signal) => handlePost(runtime, request, signal);
}
