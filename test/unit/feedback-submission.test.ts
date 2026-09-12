import assert from "node:assert/strict";
import { test } from "vitest";
import {
	createGitHubIssueTransport,
	type FeedbackSubmissionInput,
	type FeedbackSubmitDetails,
	feedbackFingerprint,
	formatPreparedDisplay,
	type IssueSubmissionRequest,
	type IssueSubmissionTransport,
	IssueTransportError,
	scrubFeedback,
	submitFeedbackIssue,
} from "../../packages/feedback/src/index.js";

const bug = { kind: "bug", title: "no replacements needed.", body: "### What happened?\n\nIt stops." } as const;
const preparedText = (input: FeedbackSubmissionInput) => formatPreparedDisplay(input, "no replacements needed.");
const transcript = (id: string, message: object) => ({ type: "message", id, message }) as const;
const message = (id: string, role: "assistant" | "user", content: string) =>
	({ type: "message", id, message: { role, content } }) as const;
function prepare(id: string, input: FeedbackSubmissionInput, display = preparedText(input)) {
	return transcript(id, {
		role: "toolResult",
		toolName: "feedback_prepare_issue",
		content: [{ type: "text", text: display }],
		details: { repository: { owner: "bastani-inc", repo: "atomic" }, ...input, privacySummary: [] },
	});
}
const submissionResult = (id: string, details: object) =>
	transcript(id, { role: "toolResult", toolName: "feedback_submit_issue", details });
class FakeTransport implements IssueSubmissionTransport {
	readonly requests: IssueSubmissionRequest[] = [];
	constructor(
		private readonly outcome: Awaited<ReturnType<IssueSubmissionTransport["createIssue"]>> | Error = {
			html_url: "https://github.com/bastani-inc/atomic/issues/42",
		},
	) {}
	async createIssue(request: IssueSubmissionRequest): ReturnType<IssueSubmissionTransport["createIssue"]> {
		this.requests.push(request);
		return this.outcome instanceof Error ? Promise.reject(this.outcome) : this.outcome;
	}
}
function setup(input: FeedbackSubmissionInput = bug, approval = "post it", transport = new FakeTransport()) {
	const branch = [
		prepare("draft", input),
		message("display", "assistant", `${preparedText(input)}\n\nWould you like edits or approval?`),
		message("approval", "user", approval),
	];
	return { branch, transport, runtime: { sessionManager: { getBranch: () => branch }, transport } };
}
const resultCode = (result: FeedbackSubmitDetails): string => (result.ok ? "ok" : result.code);
test("posts exact reviewed bug and enhancement payloads and validates the URL", async () => {
	for (const input of [bug, { kind: "enhancement", title: "Compact view", body: "### Why?\n\nMore room." } as const]) {
		const scenario = setup(input);
		await submitFeedbackIssue(input, scenario.runtime);
		assert.deepEqual(scenario.transport.requests, [
			{ owner: "bastani-inc", repo: "atomic", title: input.title, body: input.body, labels: [input.kind] },
		]);
	}
});
test("accepts clear whole-message approval and rejects every unsafe literal", async () => {
	const allowed =
		"Yes, go ahead and post it.|Approved. Please post it.|I approve this issue for posting.|Please go ahead and post it.|please post this issue".split(
			"|",
		);
	const refused =
		"never post it|under no circumstances post it|you mustn't post it|I cannot approve posting this".split("|");
	for (const [expected, texts] of [
		["ok", allowed],
		["missing-approval", refused],
	] as const)
		for (const text of texts) {
			const scenario = setup(bug, text);
			assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), expected, text);
		}
});
// #2799, review 3939726087: normal direct approval follows the exact displayed draft.
test.each(["Approved.", "Yes.", "I approve", "I approve this issue."])("accepts direct approval %j", async (text) => {
	const scenario = setup(bug, text);
	assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), "ok");
	assert.equal(scenario.transport.requests.length, 1);
});
// #2799, review 3939726085: later approval cannot revive unrelated feedback.
test("rejects approval separated from the display by unrelated conversation or tools", async () => {
	for (const intervening of [
		[message("topic", "user", "Explain git status"), message("answer", "assistant", "It lists changes.")],
		[message("revision", "user", "Change the title first")],
		[message("cancel", "user", "Do not post this")],
		[message("other-question", "assistant", "Should I delete the temporary file?")],
		[transcript("other-tool", { role: "toolResult", toolName: "bash", content: [] })],
	]) {
		const scenario = setup();
		scenario.branch.splice(2, 0, ...intervening);
		assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), "missing-approval");
		assert.equal(scenario.transport.requests.length, 0);
	}
});
test("a fresh exact display restores review after a topic change", async () => {
	const scenario = setup();
	scenario.branch.splice(
		2,
		0,
		message("topic", "user", "Explain git status"),
		message("answer", "assistant", "It lists changes."),
		message("return", "user", "Show the draft again"),
		message("redisplay", "assistant", preparedText(bug)),
	);
	assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), "ok");
});
test("rejects unrelated activity after approval and a later non-text user turn", async () => {
	for (const later of [
		message("unrelated", "assistant", "Here is your unrelated answer."),
		transcript("image", { role: "user", content: [{ type: "image", data: "synthetic", mimeType: "image/png" }] }),
		transcript("tool", { role: "toolResult", toolName: "read", content: [] }),
	]) {
		const scenario = setup();
		scenario.branch.push(later);
		assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), "missing-approval");
		assert.equal(scenario.transport.requests.length, 0);
	}
});
test("allows only submission tool calls between approval and a failed-attempt retry", async () => {
	const scenario = setup(bug, "post it", new FakeTransport(new Error("offline")));
	scenario.branch.push(
		transcript("call", {
			role: "assistant",
			content: [{ type: "toolCall", id: "submit", name: "feedback_submit_issue", arguments: bug }],
		}),
	);
	const failed = await submitFeedbackIssue(bug, scenario.runtime);
	assert.equal(resultCode(failed), "network");
	scenario.branch.push(
		submissionResult("failure", failed),
		message("relay", "assistant", failed.ok ? "" : failed.message),
		message("retry", "user", "Yes."),
	);
	const transport = new FakeTransport();
	assert.equal(resultCode(await submitFeedbackIssue(bug, { ...scenario.runtime, transport })), "ok");
	assert.equal(transport.requests.length, 1);
});
test("requires the latest exact ordinary-assistant display before approval", async () => {
	const approval = message("approval", "user", "post it");
	for (const branch of [
		[prepare("draft", bug), approval],
		[prepare("draft", bug), message("display", "assistant", bug.body), approval],
	]) {
		const transport = new FakeTransport();
		const result = await submitFeedbackIssue(bug, { sessionManager: { getBranch: () => branch }, transport });
		assert.equal(resultCode(result), "stale-draft");
	}
	const changed = setup();
	const result = await submitFeedbackIssue({ ...bug, body: `${bug.body} edited` }, changed.runtime);
	assert.equal(resultCode(result), "stale-draft");
});
// #2799, review 3939726090: persistence must never revive an older draft.
test("refuses an older draft when the newest preparation cannot be reviewed", async () => {
	const latest = { ...bug, title: "Latest draft", body: "x".repeat(63_109) };
	for (const newest of [
		prepare("latest", latest),
		prepare("latest", latest, "[persisted-output: newest draft]"),
		transcript("latest", { role: "toolResult", toolName: "feedback_prepare_issue", isError: true }),
	]) {
		const scenario = setup();
		scenario.branch.splice(2, 0, newest);
		assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), "stale-draft");
		assert.equal(scenario.transport.requests.length, 0);
	}
});
test("re-scrubs immediately before posting", async () => {
	const secret = { ...bug, body: `token=ghp_${"a".repeat(30)}` };
	const scenario = setup(secret);
	assert.equal(resultCode(await submitFeedbackIssue(secret, scenario.runtime)), "private-data");
	assert.equal(scenario.transport.requests.length, 0);
	const nested = { ...bug, body: scrubFeedback("", "/Users/bob/home/alice/x").body };
	assert.equal(resultCode(await submitFeedbackIssue(nested, setup(nested).runtime)), "ok");
});
test("maps every safe failure without leaking transport errors", async () => {
	const token = `ghp_${"x".repeat(30)}`;
	for (const [code, outcome] of [
		["authentication", new IssueTransportError("authentication", token)],
		["permission", new IssueTransportError("permission", token)],
		["rate-limit", new IssueTransportError("rate-limit", token)],
		["validation", new IssueTransportError("validation", token)],
		["network", new Error(token)],
		["abort", Object.assign(new Error(token), { name: "AbortError" })],
		["malformed-response", { html_url: "https://example.com/issues/1" }],
	] as const) {
		const result = await submitFeedbackIssue(bug, setup(bug, "post it", new FakeTransport(outcome)).runtime);
		assert.equal(resultCode(result), code);
		assert.equal(JSON.stringify(result).includes(token), false);
		assert.ok(code !== "malformed-response" || (!result.ok && result.message.includes("no confirmed result")));
	}
	const aborted = setup();
	const result = await submitFeedbackIssue(bug, { ...aborted.runtime, signal: AbortSignal.abort() });
	assert.deepEqual([resultCode(result), aborted.transport.requests.length], ["abort", 0]);
});
test("keeps credentials in headers and classifies primary and secondary limits", async () => {
	const request = { owner: "bastani-inc", repo: "atomic", title: "t", body: "b", labels: ["bug"] };
	for (const [status, remaining, retryAfter, code] of [
		[401, null, null, "authentication"],
		[403, null, null, "permission"],
		[500, null, null, "network"],
		[403, "0", null, "rate-limit"],
		[403, "4999", "60", "rate-limit"],
		[422, null, null, "validation"],
	] as const) {
		let authorization = "";
		const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			const headers = new Headers({
				...(remaining ? { "x-ratelimit-remaining": remaining } : {}),
				...(retryAfter ? { "retry-after": retryAfter } : {}),
			} as Record<string, string>);
			return new Response("{}", { status, headers });
		}) as typeof fetch;
		await assert.rejects(
			() => createGitHubIssueTransport(fetcher, { GITHUB_TOKEN: "secret-token" }).createIssue(request),
			(error: IssueTransportError) =>
				error.code === code &&
				!error.message.includes("secret-token") &&
				(code !== "network" || error.message.includes("no confirmed result")),
		);
		assert.equal(authorization, "Bearer secret-token");
	}
});
test("transport refuses missing authentication before fetch and returns malformed JSON safely", async () => {
	let calls = 0;
	const fetcher = (async (_url: string | URL | Request, _init?: RequestInit) => {
		calls++;
		return new Response("invalid synthetic JSON");
	}) as typeof fetch;
	const request = { owner: "bastani-inc", repo: "atomic", title: "t", body: "b", labels: ["bug"] };
	await assert.rejects(
		() => createGitHubIssueTransport(fetcher, {}).createIssue(request),
		(error: IssueTransportError) => error.code === "authentication",
	);
	assert.equal(calls, 0);
	assert.equal(await createGitHubIssueTransport(fetcher, { GH_TOKEN: "synthetic" }).createIssue(request), undefined);
	assert.equal(calls, 1);
});
// #2799, review 3996725863: validate external data before exposing the narrow transport response.
test("transport returns only a validated issue-response shape", async () => {
	const request = { owner: "bastani-inc", repo: "atomic", title: "t", body: "b", labels: ["bug"] };
	const url = "https://github.com/bastani-inc/atomic/issues/42";
	for (const body of ["null", "42", '"text"', "[]", "{}", '{"html_url":42}']) {
		const fetcher = (async (_url: string | URL | Request, _init?: RequestInit) => new Response(body)) as typeof fetch;
		assert.equal(
			await createGitHubIssueTransport(fetcher, { GH_TOKEN: "synthetic" }).createIssue(request),
			undefined,
			body,
		);
	}
	const fetcher = (async (_url: string | URL | Request, _init?: RequestInit) =>
		new Response(JSON.stringify({ html_url: url, extra: "not needed" }))) as typeof fetch;
	assert.deepEqual(await createGitHubIssueTransport(fetcher, { GH_TOKEN: "synthetic" }).createIssue(request), {
		html_url: url,
	});
});
test("prevents concurrent, repeated, restored, and boundary-collision duplicates", async () => {
	assert.notEqual(
		feedbackFingerprint({ kind: "bug", title: "a\nb", body: "c" }),
		feedbackFingerprint({ kind: "bug", title: "a", body: "b\nc" }),
	);
	assert.notEqual(feedbackFingerprint(bug), feedbackFingerprint({ ...bug, kind: "enhancement" }));
	const first = setup();
	const completed = await submitFeedbackIssue(bug, first.runtime);
	assert.equal(resultCode(await submitFeedbackIssue(bug, first.runtime)), "duplicate");
	const recovered = setup();
	recovered.branch.push(submissionResult("success", completed));
	const duplicate = await submitFeedbackIssue(bug, recovered.runtime);
	assert.equal(duplicate.ok ? "" : duplicate.existingUrl, completed.ok ? completed.url : "");
	let release!: (value: Awaited<ReturnType<IssueSubmissionTransport["createIssue"]>>) => void;
	const pending: IssueSubmissionTransport = { createIssue: () => new Promise((resolve) => (release = resolve)) };
	const concurrent = setup(bug, "post it", pending as FakeTransport);
	const running = submitFeedbackIssue(bug, concurrent.runtime);
	assert.equal(resultCode(await submitFeedbackIssue(bug, concurrent.runtime)), "duplicate");
	release({ html_url: "https://github.com/bastani-inc/atomic/issues/9" });
	assert.equal(resultCode(await running), "ok");
});
test("restores consumed failed approvals and permits only a fresh approval", async () => {
	const attempt = setup(bug, "post it", new FakeTransport(new Error("offline")));
	const failed = await submitFeedbackIssue(bug, attempt.runtime);
	attempt.branch.push(submissionResult("failure", failed));
	const retry = new FakeTransport();
	const restored = { sessionManager: { getBranch: () => attempt.branch }, transport: retry };
	assert.equal(resultCode(await submitFeedbackIssue(bug, restored)), "missing-approval");
	attempt.branch.push(
		message("relay", "assistant", failed.ok ? "" : failed.message),
		message("fresh", "user", "please file that issue"),
	);
	assert.equal(resultCode(await submitFeedbackIssue(bug, restored)), "ok");
});
test("a failure relay cannot authorize unrelated tool calls", async () => {
	const scenario = setup(bug, "post it", new FakeTransport(new Error("offline")));
	const failed = await submitFeedbackIssue(bug, scenario.runtime);
	assert.equal(resultCode(failed), "network");
	scenario.branch.push(
		submissionResult("failure", failed),
		transcript("relay", {
			role: "assistant",
			content: [
				{ type: "text", text: failed.ok ? "" : failed.message },
				{ type: "toolCall", id: "other", name: "bash", arguments: { command: "git status" } },
			],
		}),
		message("retry", "user", "Yes."),
	);
	const transport = new FakeTransport();
	assert.equal(resultCode(await submitFeedbackIssue(bug, { ...scenario.runtime, transport })), "missing-approval");
	assert.equal(transport.requests.length, 0);
});
// #2799, review 3996725863: malformed persisted messages must fail closed without throwing.
test("ignores malformed message envelopes without reviving an older approval", async () => {
	for (const raw of ['"invalid"', "42", "true", "[]", "{}"]) {
		const malformed: object = JSON.parse(raw);
		const scenario = setup();
		scenario.branch.push(transcript("malformed", malformed));
		assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), "missing-approval");
		assert.equal(scenario.transport.requests.length, 0);
	}
});
// #2799, review 3996725863: projection cannot discard an invalid competing tool call.
test("malformed transcript boundaries cannot revive a draft or hide non-submission calls", async () => {
	for (const details of [
		undefined,
		null,
		[],
		{},
		{ ...bug, repository: { owner: "other", repo: "atomic" } },
		{ ...bug, title: 42, repository: { owner: "bastani-inc", repo: "atomic" } },
	]) {
		const scenario = setup();
		scenario.branch.splice(
			2,
			0,
			transcript("latest", {
				role: "toolResult",
				toolName: "feedback_prepare_issue",
				details,
				content: [{ type: "text", text: preparedText(bug) }],
			}),
		);
		assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), "stale-draft");
		assert.equal(scenario.transport.requests.length, 0);
	}
	for (const name of [undefined, null, 42, "bash"]) {
		const scenario = setup();
		scenario.branch.push(
			transcript("calls", {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "feedback_submit_issue" },
					{ type: "toolCall", ...(name === undefined ? {} : { name }) },
				],
			}),
		);
		assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), "missing-approval");
		assert.equal(scenario.transport.requests.length, 0);
	}
});
// #2799, review 3996725863: preserve ordinary non-text content around the reviewed draft.
test("ignores thinking and image blocks while retaining reviewed text and submission calls", async () => {
	const scenario = setup();
	const ignored = [
		{ type: "thinking", thinking: "synthetic" },
		{ type: "image", data: "synthetic", mimeType: "image/png" },
		null,
		{ type: "text", text: 42 },
	];
	scenario.branch[1] = transcript("display", {
		role: "assistant",
		content: [...ignored, { type: "text", text: preparedText(bug) }],
	});
	scenario.branch[2] = transcript("approval", { role: "user", content: [...ignored, { type: "text", text: "Yes." }] });
	scenario.branch.push(
		transcript("call", {
			role: "assistant",
			content: [...ignored, { type: "toolCall", name: "feedback_submit_issue" }],
		}),
	);
	assert.equal(resultCode(await submitFeedbackIssue(bug, scenario.runtime)), "ok");
	assert.equal(scenario.transport.requests.length, 1);
});
