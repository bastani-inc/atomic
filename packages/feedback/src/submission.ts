import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { FEEDBACK_REPOSITORY, ISSUE_LABELS } from "./draft.js";
import { scrubFeedback } from "./privacy.js";
export type IssueSubmissionRequest = Readonly<
	Record<"owner" | "repo" | "title" | "body", string> & { labels: readonly string[] }
>;
type IssueSubmissionResponse = Readonly<{ html_url: string }>;
export type IssueSubmissionTransport = {
	createIssue(request: IssueSubmissionRequest, signal?: AbortSignal): Promise<IssueSubmissionResponse | undefined>;
};
const messages = {
	authentication: "GitHub authentication failed. The reviewed draft was not posted.",
	permission: "GitHub denied permission to create the issue. The reviewed draft was not posted.",
	"rate-limit": "GitHub rate-limited the submission. The reviewed draft was not posted.",
	validation: "GitHub rejected the issue as invalid. The reviewed draft was not posted.",
	network: "The issue submission has no confirmed result. Check bastani-inc/atomic before approving another attempt.",
	abort: "The issue submission was aborted before a confirmed result. Check bastani-inc/atomic before approving another attempt.",
	"malformed-response":
		"GitHub returned an invalid issue response with no confirmed result. Check bastani-inc/atomic before approving another attempt.",
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
export class IssueTransportError extends Error {
	constructor(
		readonly code: FeedbackSubmissionFailure,
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
type MessageContent =
	| Readonly<{ type: "text"; text: string }>
	| Readonly<{ type: "toolCall"; name: string | undefined }>;
type SubmissionMessage = Readonly<{
	role: string;
	toolName: string | undefined;
	isError: boolean;
	content: string | readonly MessageContent[];
	details: object | undefined;
}>;
// Only untrusted ingress uses unknown; callers receive validated domain projections.
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;
function messageContent(value: unknown): string | readonly MessageContent[] {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return [];
	const content: MessageContent[] = [];
	for (const item of value) {
		if (!isObject(item) || !("type" in item)) continue;
		if (item.type === "text" && "text" in item && typeof item.text === "string")
			content.push({ type: "text", text: item.text });
		else if (item.type === "toolCall")
			content.push({
				type: "toolCall",
				name: "name" in item && typeof item.name === "string" ? item.name : undefined,
			});
	}
	return content;
}
function submissionMessage(value: object): SubmissionMessage | undefined {
	if (!isObject(value) || !("role" in value) || typeof value.role !== "string") return;
	return {
		role: value.role,
		toolName: "toolName" in value && typeof value.toolName === "string" ? value.toolName : undefined,
		isError: "isError" in value && value.isError === true,
		content: messageContent("content" in value ? value.content : undefined),
		details: "details" in value && isObject(value.details) ? value.details : undefined,
	};
}
const toolResult = (entry: BranchEntry, name: string): SubmissionMessage | undefined => {
	if (entry.type !== "message" || !entry.message) return;
	const message = submissionMessage(entry.message);
	return message?.role === "toolResult" && message.toolName === name ? message : undefined;
};
function contentText(content: SubmissionMessage["content"], separator = ""): string {
	return typeof content === "string"
		? ""
		: content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join(separator);
}
const preparedResultSchema = Type.Object({
	kind: Type.Union([Type.Literal("bug"), Type.Literal("enhancement")]),
	title: Type.String(),
	body: Type.String(),
	repository: Type.Object({
		owner: Type.Literal(FEEDBACK_REPOSITORY.owner),
		repo: Type.Literal(FEEDBACK_REPOSITORY.repo),
	}),
});
type PreparedResult = Static<typeof preparedResultSchema>;
function preparedResult(details: object | undefined): PreparedResult | undefined {
	return Check(preparedResultSchema, details) ? details : undefined;
}
export function formatPreparedDisplay(input: FeedbackSubmissionInput, privacyNote: string): string {
	return `Repository: ${FEEDBACK_REPOSITORY.owner}/${FEEDBACK_REPOSITORY.repo}\nKind: ${input.kind}\n\n${input.title}\n\n${input.body}\n\nPrivacy scrubbed: ${privacyNote}`;
}
type PreparedDraft = { readonly draft: FeedbackSubmissionInput; readonly display: string };
function prepared(entry: BranchEntry): PreparedDraft | undefined {
	const message = toolResult(entry, "feedback_prepare_issue");
	if (!message || message.isError) return;
	const details = preparedResult(message.details);
	if (!details) return;
	const draft: FeedbackSubmissionInput = { kind: details.kind, title: details.title, body: details.body };
	const display = contentText(message.content);
	const prefix = formatPreparedDisplay(draft, "");
	return display.startsWith(prefix) && display.endsWith(".") ? { draft, display } : undefined;
}
function roleText(entry: BranchEntry, role: "assistant" | "user"): string | undefined {
	if (entry.type !== "message" || !entry.message) return;
	const message = submissionMessage(entry.message);
	if (message?.role !== role) return;
	const text = typeof message.content === "string" ? message.content : contentText(message.content, "\n");
	return text || undefined;
}
const approved = (text: string): boolean =>
	/^(?:yes|approved|i approve(?: (?:this|that|the) issue)?|(?:(?:(?:yes|approved)[,.!]?\s+)?(?:please\s+)?(?:go ahead(?: and)?\s+)?(?:post|submit|file|open|send)\s+(?:it|this(?: issue)?|that(?: issue)?|the issue)|ship it|i approve (?:(?:posting|submitting|filing|opening|sending) (?:this|that|the) issue|(?:this|that|the) issue for (?:posting|submitting|filing|opening|sending))))[.!]?$/iu.test(
		text.trim(),
	);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const feedbackFingerprint = (input: FeedbackSubmissionInput): string =>
	hash(JSON.stringify([input.kind, input.title, input.body]));
function onlySubmissionActivity(branch: readonly BranchEntry[], fingerprint: string): boolean {
	let failureMessage: string | undefined;
	return branch.every((entry) => {
		if (entry.type !== "message") return true;
		const user = roleText(entry, "user");
		if (user !== undefined) return approved(user);
		const result = toolResult(entry, "feedback_submit_issue");
		if (result?.details) {
			const details = result.details;
			if (
				!("ok" in details) ||
				details.ok !== false ||
				!("fingerprint" in details) ||
				details.fingerprint !== fingerprint ||
				!("message" in details) ||
				typeof details.message !== "string"
			)
				return false;
			failureMessage = details.message;
			return true;
		}
		const assistant = roleText(entry, "assistant");
		if (!entry.message) return false;
		const message = submissionMessage(entry.message);
		if (message?.role !== "assistant") return false;
		if (failureMessage && assistant === failureMessage && typeof message.content === "string") return true;
		if (typeof message.content === "string") return false;
		const calls = message.content.filter((item) => item.type === "toolCall");
		if (failureMessage && assistant === failureMessage && calls.length === 0) return true;
		return calls.length > 0 && calls.every((call) => call.name === "feedback_submit_issue");
	});
}
function syncSubmissionHistory(branch: readonly BranchEntry[], state: SessionState, fingerprint: string): void {
	for (const entry of branch) {
		const result = toolResult(entry, "feedback_submit_issue");
		const details = result?.details;
		if (!details || !("ok" in details) || !("fingerprint" in details) || details.fingerprint !== fingerprint)
			continue;
		if (details.ok === true && "url" in details && typeof details.url === "string")
			state.successes.set(fingerprint, details.url);
		else if (
			details.ok === false &&
			"approvalFingerprint" in details &&
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
	const draftIndex = branch.findLastIndex((entry) => toolResult(entry, "feedback_prepare_issue") !== undefined);
	const preparedDraft = draftIndex < 0 ? undefined : prepared(branch[draftIndex]);
	if (
		!preparedDraft ||
		preparedDraft.draft.kind !== input.kind ||
		preparedDraft.draft.title !== input.title ||
		preparedDraft.draft.body !== input.body
	)
		return failure("stale-draft");
	const approvalIndex = branch.findLastIndex(
		(entry, index) => index > draftIndex && entry.message && submissionMessage(entry.message)?.role === "user",
	);
	const approvalText = approvalIndex < 0 ? undefined : roleText(branch[approvalIndex], "user");
	if (!approvalText || !approved(approvalText)) return failure("missing-approval");
	const displayIndex = branch.findLastIndex(
		(entry, index) =>
			index > draftIndex &&
			index < approvalIndex &&
			roleText(entry, "assistant")?.includes(preparedDraft.display) === true,
	);
	if (displayIndex < 0) return failure("stale-draft");
	if (!onlySubmissionActivity(branch.slice(displayIndex + 1), fingerprint)) return failure("missing-approval");
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
		const url = response.html_url;
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
	const primary = { 401: "authentication", 422: "validation", 429: "rate-limit" };
	const { status, headers } = response;
	const limited = status === 403 && (headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0");
	const code =
		primary[status as 401 | 422 | 429] ?? (limited ? "rate-limit" : status === 403 ? "permission" : "network");
	return new IssueTransportError(code as FeedbackSubmissionFailure, messages[code as FeedbackSubmissionFailure]);
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
			const value: unknown = await response.json().catch(() => undefined);
			return isObject(value) && "html_url" in value && typeof value.html_url === "string"
				? { html_url: value.html_url }
				: undefined;
		},
	};
}
