import { createHash } from "node:crypto";
import { FEEDBACK_REPOSITORY, ISSUE_LABELS } from "./draft.js";
import { scrubFeedback } from "./privacy.js";
export type IssueSubmissionRequest = Readonly<
	Record<"owner" | "repo" | "title" | "body", string> & { labels: readonly string[] }
>;
export type IssueSubmissionTransport = {
	createIssue(request: IssueSubmissionRequest, signal?: AbortSignal): Promise<unknown>;
};
const messages = {
	authentication: "GitHub authentication failed. The reviewed draft was not posted.",
	permission: "GitHub denied permission to create the issue. The reviewed draft was not posted.",
	"rate-limit": "GitHub rate-limited the submission. The reviewed draft was not posted.",
	validation: "GitHub rejected the issue as invalid. The reviewed draft was not posted.",
	network: "The issue submission has no confirmed result. Check bastani-inc/atomic before approving another attempt.",
	"unexpected-status": "GitHub returned an unexpected response; the reviewed draft was not posted.",
	abort: "The issue submission was aborted before a confirmed result. Check bastani-inc/atomic before approving another attempt.",
	"malformed-response": "GitHub returned an invalid issue response; no success is being reported.",
	"stale-draft": "The submitted content does not match the most recent prepared draft. Review the latest draft first.",
	"missing-approval": "Clear approval to post the most recent draft is required in a new ordinary user message.",
	"private-data": "The reviewed content still contains private data. Prepare and review the scrubbed draft again.",
	duplicate: "This reviewed draft has already been submitted or is currently being submitted.",
} as const;
export type FeedbackSubmissionFailure = keyof typeof messages;
type FailedSubmitDetails = Readonly<{
	readonly ok: false;
	readonly code: FeedbackSubmissionFailure;
	readonly message: string;
}> &
	Partial<Record<"existingUrl" | "fingerprint" | "approvalFingerprint", string>>;
export type FeedbackSubmitDetails = Readonly<{ ok: true; url: string; fingerprint: string }> | FailedSubmitDetails;
export type FeedbackSubmissionInput = Readonly<Record<"title" | "body", string> & { kind: keyof typeof ISSUE_LABELS }>;
type BranchEntry = { readonly type: string; readonly id: string; readonly message?: object };
export type FeedbackSubmissionRuntime = {
	readonly sessionManager: object & { getBranch(): readonly BranchEntry[] };
	readonly transport: IssueSubmissionTransport;
	readonly signal?: AbortSignal;
};
type TransportFailure = "authentication" | "permission" | "rate-limit" | "validation" | "unexpected-status";
export class IssueTransportError extends Error {
	constructor(
		readonly code: TransportFailure,
		message: string,
	) {
		super(message);
	}
}
type SessionState = { inflight: Set<string>; attempts: Map<string, string>; successes: Map<string, string> };
type FailureExtra = Partial<Pick<FailedSubmitDetails, "fingerprint" | "approvalFingerprint" | "existingUrl">>;
const sessions = new WeakMap<object, SessionState>();
function failure(code: FeedbackSubmissionFailure, extra: FailureExtra = {}): FeedbackSubmitDetails {
	const message = extra.existingUrl ? `${messages[code]} Existing issue: ${extra.existingUrl}` : messages[code];
	return { ok: false, code, message, ...extra };
}
const record = (value: object): Record<string, unknown> => value as Record<string, unknown>;
const toolResult = (entry: BranchEntry, name: string): Record<string, unknown> | undefined => {
	if (entry.type !== "message" || !entry.message) return;
	const message = record(entry.message);
	return message.role === "toolResult" && message.toolName === name ? message : undefined;
};
function contentText(content: unknown, separator = ""): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (typeof item === "object" && item && record(item).type === "text" ? record(item).text : ""))
		.filter((text): text is string => typeof text === "string")
		.join(separator);
}
type PreparedDraft = { readonly draft: FeedbackSubmissionInput; readonly display: string };
function prepared(entry: BranchEntry): PreparedDraft | undefined {
	const message = toolResult(entry, "feedback_prepare_issue");
	if (!message || message.isError === true || typeof message.details !== "object" || !message.details) return;
	const details = record(message.details);
	const repository =
		typeof details.repository === "object" && details.repository ? record(details.repository) : undefined;
	if (
		(details.kind !== "bug" && details.kind !== "enhancement") ||
		typeof details.title !== "string" ||
		typeof details.body !== "string" ||
		repository?.owner !== FEEDBACK_REPOSITORY.owner ||
		repository.repo !== FEEDBACK_REPOSITORY.repo
	)
		return;
	const draft: FeedbackSubmissionInput = { kind: details.kind, title: details.title, body: details.body };
	const display = contentText(message.content);
	const prefix = `Repository: ${FEEDBACK_REPOSITORY.owner}/${FEEDBACK_REPOSITORY.repo}\nKind: ${draft.kind}\n\n${draft.title}\n\n${draft.body}\n\nPrivacy scrubbed: `;
	return display.startsWith(prefix) && display.endsWith(".") ? { draft, display } : undefined;
}
function roleText(entry: BranchEntry, role: "assistant" | "user"): string | undefined {
	if (entry.type !== "message" || !entry.message) return;
	const message = record(entry.message);
	if (message.role !== role) return;
	const text = typeof message.content === "string" ? message.content : contentText(message.content, "\n");
	return text || undefined;
}
const approved = (text: string): boolean =>
	/^(?:(?:(?:yes|approved)[,.!]?\s+)?(?:please\s+)?(?:go ahead(?: and)?\s+)?(?:post|submit|file|open|send)\s+(?:it|this(?: issue)?|that(?: issue)?|the issue)|ship it|i approve (?:(?:posting|submitting|filing|opening|sending) (?:this|that|the) issue|(?:this|that|the) issue for (?:posting|submitting|filing|opening|sending)))[.!]?$/iu.test(
		text.trim(),
	);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const feedbackFingerprint = (input: FeedbackSubmissionInput): string =>
	hash(JSON.stringify([input.kind, input.title, input.body]));
function syncSubmissionHistory(branch: readonly BranchEntry[], state: SessionState, fingerprint: string): void {
	for (const entry of branch) {
		const result = toolResult(entry, "feedback_submit_issue");
		const details =
			result && typeof result.details === "object" && result.details ? record(result.details) : undefined;
		if (details?.ok === true && details.fingerprint === fingerprint && typeof details.url === "string")
			state.successes.set(fingerprint, details.url);
		else if (
			details?.ok === false &&
			details.fingerprint === fingerprint &&
			typeof details.approvalFingerprint === "string"
		)
			state.attempts.set(fingerprint, details.approvalFingerprint);
	}
}
export async function submitFeedbackIssue(
	input: FeedbackSubmissionInput,
	runtime: FeedbackSubmissionRuntime,
): Promise<FeedbackSubmitDetails> {
	const fingerprint = feedbackFingerprint(input);
	const branch = runtime.sessionManager.getBranch();
	const state = sessions.get(runtime.sessionManager) ?? {
		inflight: new Set<string>(),
		attempts: new Map<string, string>(),
		successes: new Map<string, string>(),
	};
	sessions.set(runtime.sessionManager, state);
	syncSubmissionHistory(branch, state, fingerprint);
	const existing = state.successes.get(fingerprint);
	if (existing) return failure("duplicate", { existingUrl: existing });
	if (state.inflight.has(fingerprint)) return failure("duplicate");
	const draftIndex = branch.findLastIndex((entry) => prepared(entry) !== undefined);
	const preparedDraft = draftIndex < 0 ? undefined : prepared(branch[draftIndex]);
	if (
		!preparedDraft ||
		preparedDraft.draft.kind !== input.kind ||
		preparedDraft.draft.title !== input.title ||
		preparedDraft.draft.body !== input.body
	)
		return failure("stale-draft");
	const approvalIndex = branch.findLastIndex(
		(entry, index) => index > draftIndex && roleText(entry, "user") !== undefined,
	);
	const approvalText = approvalIndex < 0 ? undefined : roleText(branch[approvalIndex], "user");
	if (!approvalText || !approved(approvalText)) return failure("missing-approval");
	const displayed = branch
		.slice(draftIndex + 1, approvalIndex)
		.some((entry) => roleText(entry, "assistant")?.includes(preparedDraft.display) === true);
	if (!displayed) return failure("stale-draft");
	const attempt = { fingerprint, approvalFingerprint: hash(JSON.stringify(["approval", branch[approvalIndex].id])) };
	if (state.attempts.get(fingerprint) === attempt.approvalFingerprint) return failure("missing-approval");
	state.attempts.set(fingerprint, attempt.approvalFingerprint);
	const scrubbed = scrubFeedback(input.title, input.body);
	if (runtime.signal?.aborted) return failure("abort", attempt);
	if (scrubbed.title !== input.title || scrubbed.body !== input.body) return failure("private-data", attempt);
	state.inflight.add(fingerprint);
	try {
		const response = await runtime.transport.createIssue(
			{ ...FEEDBACK_REPOSITORY, title: scrubbed.title, body: scrubbed.body, labels: [ISSUE_LABELS[input.kind]] },
			runtime.signal,
		);
		if (typeof response !== "object" || !response) return failure("malformed-response", attempt);
		const url = record(response).html_url;
		if (typeof url !== "string" || !/^https:\/\/github\.com\/bastani-inc\/atomic\/issues\/[1-9]\d*$/u.test(url))
			return failure("malformed-response", attempt);
		state.successes.set(fingerprint, url);
		return { ok: true, url, fingerprint };
	} catch (error) {
		if (runtime.signal?.aborted || (error instanceof Error && error.name === "AbortError"))
			return failure("abort", attempt);
		if (error instanceof IssueTransportError) return failure(error.code, attempt);
		return failure("network", attempt);
	} finally {
		state.inflight.delete(fingerprint);
	}
}
function responseFailure(response: Response): IssueTransportError | Error {
	const known: Partial<Record<number, TransportFailure>> = {
		401: "authentication",
		422: "validation",
		429: "rate-limit",
	};
	const code =
		known[response.status] ??
		(response.status === 403
			? response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"
				? "rate-limit"
				: "permission"
			: "unexpected-status");
	return new IssueTransportError(code, messages[code]);
}
export function createGitHubIssueTransport(
	fetcher: typeof fetch = fetch,
	env: Readonly<Record<string, string | undefined>> = process.env,
): IssueSubmissionTransport {
	return {
		async createIssue(request, signal) {
			const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
			if (!token) throw new IssueTransportError("authentication", messages.authentication);
			let response: Response;
			try {
				response = await fetcher(`https://api.github.com/repos/${request.owner}/${request.repo}/issues`, {
					method: "POST",
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ title: request.title, body: request.body, labels: request.labels }),
					signal,
				});
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				throw new Error(messages.network);
			}
			if (!response.ok) throw responseFailure(response);
			return response.json().catch(() => undefined);
		},
	};
}
