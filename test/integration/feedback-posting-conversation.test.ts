import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessageText } from "../../packages/coding-agent/test/suite/harness.ts";
import {
	assistantMessages,
	createFeedbackConversationHarness,
	settleTurn,
	transcriptText,
} from "./feedback-conversation-harness.ts";

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

		expect(fetcher).toHaveBeenCalledTimes(1);
		const [, init] = fetcher.mock.calls[0] ?? [];
		expect(JSON.parse(String(init?.body))).toMatchObject({ labels: ["enhancement"], title: draft.title, body });
		expect(assistantMessages(harness).at(-1)).toContain("Posted: https://github.com/bastani-inc/atomic/issues/42");
		expect(transcriptText(harness)).not.toContain(token);
	});

	it("renders an honest posting error while keeping the reviewed draft available for retry", async () => {
		configureToken();
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("unauthorized", { status: 401 }),
		);
		vi.stubGlobal("fetch", fetcher);
		const harness = await displayedDraft();
		const reviewedDraft = assistantMessages(harness).at(-1);
		expect(reviewedDraft).toBeDefined();
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

		expect(fetcher).toHaveBeenCalledTimes(1);
		const result = harness.session.messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === "feedback_submit_issue",
		);
		if (result?.role !== "toolResult") throw new Error("expected feedback submission result");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("GitHub authentication failed. The reviewed draft was not posted.");
		const renderedError = assistantMessages(harness).at(-1);
		expect(renderedError).toContain("GitHub authentication failed. The reviewed draft was not posted.");
		expect(renderedError).toContain("draft remains editable; you can retry when ready");
		expect(assistantMessages(harness)).toContain(reviewedDraft);
		expect(transcriptText(harness)).not.toContain("https://github.com/bastani-inc/atomic/issues/");
		expect(transcriptText(harness)).not.toContain(token);
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
	});
});
