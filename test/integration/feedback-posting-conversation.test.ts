import assert from "node:assert/strict";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import { getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import { formatPreparedDisplay, submitFeedbackIssue } from "../../packages/feedback/src/index.js";
import {
	assistantMessages,
	createFeedbackConversationHarness,
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
		assert.ok(!transcriptText(harness).includes("https://github.com/bastani-inc/atomic/issues/"));
		assert.ok(!transcriptText(harness).includes(token));
		assert.equal(harness.session.messages.at(-1)?.role, "assistant");
	});
});
