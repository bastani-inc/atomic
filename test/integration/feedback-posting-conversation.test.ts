import assert from "node:assert/strict";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import { getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import { formatPreparedDisplay, submitFeedbackIssue } from "../../packages/feedback/src/index.js";
import {
	assertNoIssueLink,
	assistantMessages,
	createFeedbackConversationHarness,
	ISSUE_LINK,
	settleTurn,
	transcriptText,
} from "./feedback-conversation-harness.js";

const cleanups: Array<() => void> = [];
const token = "test-token-that-must-not-appear";
const draft = {
	kind: "enhancement",
	title: "Keyboard navigation",
	change: "Add keyboard navigation",
	why: "Improve accessibility",
} as const;
const body = "### What do you want to change?\n\nAdd keyboard navigation\n\n### Why?\n\nImprove accessibility";

function draftResponses(): FauxResponseStep[] {
	return [
		fauxAssistantMessage(fauxToolCall("feedback_prepare_issue", draft), { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			return fauxAssistantMessage(`${getMessageText(result)}\n\nWould you like edits or approval?`);
		},
	];
}

async function displayedDraft() {
	const harness = await createFeedbackConversationHarness();
	cleanups.push(harness.cleanup);
	harness.setResponses(draftResponses());
	await harness.session.prompt("/feedback Add keyboard navigation");
	await settleTurn(harness);
	return harness;
}

function configureToken(): void {
	const previousGitHub = process.env.GITHUB_TOKEN;
	const previousGh = process.env.GH_TOKEN;
	process.env.GITHUB_TOKEN = token;
	delete process.env.GH_TOKEN;
	cleanups.push(() => {
		if (previousGitHub === undefined) delete process.env.GITHUB_TOKEN;
		else process.env.GITHUB_TOKEN = previousGitHub;
		if (previousGh === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = previousGh;
	});
}

type SubmitResult = Extract<
	Awaited<ReturnType<typeof displayedDraft>>["session"]["messages"][number],
	{ role: "toolResult" }
>;
function submitResults(harness: Awaited<ReturnType<typeof displayedDraft>>): SubmitResult[] {
	return harness.session.messages.filter(
		(message): message is SubmitResult =>
			message.role === "toolResult" && message.toolName === "feedback_submit_issue",
	);
}

function submitThenRelay(): FauxResponseStep[] {
	return [
		fauxAssistantMessage(fauxToolCall("feedback_submit_issue", { kind: "enhancement", title: draft.title, body }), {
			stopReason: "toolUse",
		}),
		(context) =>
			fauxAssistantMessage(getMessageText(context.messages.findLast((message) => message.role === "toolResult"))),
	];
}

describe("feedback posting conversation", () => {
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
		vi.unstubAllGlobals();
	});

	// #2799: retain the parent slice's bug, bare approval, and exact-display-only transport scenario.
	it("posts the displayed draft after a fresh conversational approval", async () => {
		const input = { kind: "bug", title: "C", body: "B" } as const;
		const prepared = formatPreparedDisplay(input, "no replacements needed.");
		const entry = (id: string, message: object) => ({ type: "message", id, message }) as const;
		const branch = [
			entry("draft", {
				role: "toolResult",
				toolName: "feedback_prepare_issue",
				content: [{ type: "text", text: prepared }],
				details: { repository: { owner: "bastani-inc", repo: "atomic" }, ...input },
			}),
			entry("display", { role: "assistant", content: prepared }),
			entry("approval", { role: "user", content: "post it" }),
		] as const;
		const createIssue = vi.fn(async () => ({ html_url: "https://github.com/bastani-inc/atomic/issues/42" }));
		const result = await submitFeedbackIssue(input, {
			sessionManager: { getBranch: () => branch },
			transport: { createIssue },
		});
		assert.equal(result.ok, true);
		assert.equal(createIssue.mock.calls.length, 1);
	});

	it("submits exactly once after ordinary approval and renders the issue URL", async () => {
		configureToken();
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ html_url: "https://github.com/bastani-inc/atomic/issues/42" }), {
					status: 201,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetcher);
		const harness = await displayedDraft();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("feedback_submit_issue", { kind: "enhancement", title: draft.title, body }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				return fauxAssistantMessage(`Posted: ${getMessageText(result)}`);
			},
		]);

		await harness.session.prompt("yes, post it");

		assert.equal(fetcher.mock.calls.length, 1);
		const [, init] = fetcher.mock.calls[0] ?? [];
		assert.deepEqual(JSON.parse(String(init?.body)), { labels: ["enhancement"], title: draft.title, body });
		assert.ok(assistantMessages(harness).at(-1)?.includes("Posted: https://github.com/bastani-inc/atomic/issues/42"));
		// The link detector must recognize a real posted link, or assertNoIssueLink elsewhere proves nothing.
		assert.match(transcriptText(harness), ISSUE_LINK);
		assert.ok(!transcriptText(harness).includes(token));
	});

	it("renders an honest posting error while keeping the reviewed draft available for retry", async () => {
		configureToken();
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("unauthorized", { status: 401 }),
		);
		vi.stubGlobal("fetch", fetcher);
		const harness = await displayedDraft();
		const reviewedDraft = assistantMessages(harness).at(-1);
		assert.ok(reviewedDraft);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("feedback_submit_issue", { kind: "enhancement", title: draft.title, body }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				return fauxAssistantMessage(
					`${getMessageText(result)} The draft remains editable; you can retry when ready.`,
				);
			},
		]);

		await harness.session.prompt("please post it");

		assert.equal(fetcher.mock.calls.length, 1);
		const result = harness.session.messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === "feedback_submit_issue",
		);
		if (result?.role !== "toolResult") throw new Error("expected feedback submission result");
		assert.equal(result.isError, true);
		assert.equal(getMessageText(result), "GitHub authentication failed. The reviewed draft was not posted.");
		const renderedError = assistantMessages(harness).at(-1);
		assert.ok(renderedError?.includes("GitHub authentication failed. The reviewed draft was not posted."));
		assert.ok(renderedError?.includes("draft remains editable; you can retry when ready"));
		assert.ok(assistantMessages(harness).includes(reviewedDraft));
		assertNoIssueLink(harness);
		assert.ok(!transcriptText(harness).includes(token));
		assert.equal(harness.session.messages.at(-1)?.role, "assistant");
	});

	// #2799: a marked failure keeps the draft postable; the recorded attempt must survive the error tool result
	// so a fresh ordinary approval is accepted once, and the consumed approval is not reused.
	it("posts once after a fresh approval follows a marked submission failure", async () => {
		configureToken();
		const statuses = [401, 201];
		const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
			const status = statuses.shift();
			if (status === 201) {
				return new Response(JSON.stringify({ html_url: "https://github.com/bastani-inc/atomic/issues/42" }), {
					status,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("unauthorized", { status: 401 });
		});
		vi.stubGlobal("fetch", fetcher);
		const harness = await displayedDraft();
		harness.setResponses(submitThenRelay());
		await harness.session.prompt("please post it");

		const [failed] = submitResults(harness);
		assert.ok(failed);
		assert.equal(failed.isError, true);
		assert.equal(fetcher.mock.calls.length, 1);
		const failedDetails = failed.details;
		assert.ok(
			failedDetails &&
				typeof failedDetails === "object" &&
				"ok" in failedDetails &&
				"code" in failedDetails &&
				"fingerprint" in failedDetails &&
				"approvalFingerprint" in failedDetails,
		);
		assert.equal(failedDetails.ok, false);
		assert.equal(failedDetails.code, "authentication");
		assert.match(String(failedDetails.fingerprint), /^[0-9a-f]{64}$/u);
		assert.match(String(failedDetails.approvalFingerprint), /^[0-9a-f]{64}$/u);
		assertNoIssueLink(harness);

		harness.setResponses(submitThenRelay());
		await harness.session.prompt("yes, post it");

		const results = submitResults(harness);
		assert.equal(results.length, 2);
		assert.equal(fetcher.mock.calls.length, 2);
		const posted = results[1];
		assert.ok(posted);
		assert.equal(posted.isError, false);
		assert.equal(getMessageText(posted), "https://github.com/bastani-inc/atomic/issues/42");
		const postedDetails = posted.details;
		assert.ok(
			postedDetails && typeof postedDetails === "object" && "ok" in postedDetails && "fingerprint" in postedDetails,
		);
		assert.equal(postedDetails.ok, true);
		assert.equal(postedDetails.fingerprint, failedDetails.fingerprint);
		assert.equal(assistantMessages(harness).at(-1), "https://github.com/bastani-inc/atomic/issues/42");
		assert.match(transcriptText(harness), ISSUE_LINK);
		assert.ok(!transcriptText(harness).includes(token));
	});
});
