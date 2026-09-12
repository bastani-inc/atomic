import assert from "node:assert/strict";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import { getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import type { BugFeedbackDraft, FeedbackDraft } from "../../packages/feedback/src/draft.js";
import {
	assertNoIssueLink,
	assistantMessages,
	createFeedbackConversationHarness,
	settleTurn,
	transcriptText,
} from "./feedback-conversation-harness.js";

const cleanups: Array<() => void> = [];

const initialDraft = {
	kind: "enhancement",
	title: "Keyboard navigation",
	change: "Add keyboard navigation",
	why: "Improve accessibility",
} as const;

function prepareThenDisplay(draft: FeedbackDraft = initialDraft): FauxResponseStep[] {
	return [
		fauxAssistantMessage(fauxToolCall("feedback_prepare_issue", draft), { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			return fauxAssistantMessage(`${getMessageText(result)}\n\nWould you like edits or approval?`);
		},
	];
}

type ToolResult = Extract<Harness["session"]["messages"][number], { role: "toolResult" }>;
function preparedResults(harness: Harness): ToolResult[] {
	return harness.session.messages.filter(
		(message): message is ToolResult =>
			message.role === "toolResult" && message.toolName === "feedback_prepare_issue",
	);
}

function assertNoSubmission(harness: Harness): void {
	assert.equal(
		harness.session.messages.some(
			(message) => message.role === "toolResult" && message.toolName === "feedback_submit_issue",
		),
		false,
	);
}

describe("feedback follow-up conversation", () => {
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
		vi.unstubAllGlobals();
	});

	// #2799: a revision must run preparation again and display the exact scrubbed result.
	it("prepares and displays a newly scrubbed draft after an ordinary revision request", async () => {
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const harness = await createFeedbackConversationHarness();
		cleanups.push(harness.cleanup);
		harness.setResponses(prepareThenDisplay());
		await harness.session.prompt("/feedback Add keyboard navigation");
		await settleTurn(harness);
		harness.setResponses(
			prepareThenDisplay({
				...initialDraft,
				change: `Add keyboard navigation without exposing ${secret}`,
				why: "Improve keyboard-only workflows",
			}),
		);

		await harness.session.prompt("Please emphasize keyboard-only workflows and remove private credentials.");

		const prepared = preparedResults(harness);
		assert.equal(prepared.length, 2);
		const revisedDraft = assistantMessages(harness).at(-1);
		assert.equal(revisedDraft, `${getMessageText(prepared[1])}\n\nWould you like edits or approval?`);
		assert.ok(revisedDraft.includes("Add keyboard navigation without exposing [REDACTED]"));
		assert.ok(revisedDraft.includes("Improve keyboard-only workflows"));
		assert.ok(revisedDraft.includes("Repository: bastani-inc/atomic\nKind: enhancement"));
		assert.ok(revisedDraft.includes("Privacy scrubbed: github-token (1)."));
		assert.ok(!transcriptText(harness).includes(secret));
		assertNoSubmission(harness);
		assert.equal(fetcher.mock.calls.length, 0);
	});

	// #2799: revisions of bug reports must re-prepare too, not hand-edit the reviewed Markdown.
	it("re-prepares a bug revision and displays the new exact scrubbed draft", async () => {
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const harness = await createFeedbackConversationHarness();
		cleanups.push(harness.cleanup);
		const bug: BugFeedbackDraft = {
			kind: "bug",
			title: "Keyboard navigation loses focus",
			description: "Focus disappears after opening settings",
			repro: "Open settings and press Tab",
			expected: "Focus stays visible",
			isolation: "Not tested without extensions",
			evidence: "Investigation unavailable",
			unknowns: "Cause is unknown",
		};
		harness.setResponses(prepareThenDisplay(bug));
		await harness.session.prompt("/feedback Bug: settings loses keyboard focus. Open settings and press Tab.");
		await settleTurn(harness);
		const originalDisplay = assistantMessages(harness).at(-1);
		assert.ok(originalDisplay);
		harness.setResponses(
			prepareThenDisplay({
				...bug,
				repro: "Open settings, press Tab twice, then close settings",
				description: `Focus disappears after closing settings; diagnostic token ${secret}`,
			}),
		);

		await harness.session.prompt(
			"Please correct the steps: press Tab twice, then close settings. Remove private tokens.",
		);

		const prepared = preparedResults(harness);
		assert.equal(prepared.length, 2);
		assert.deepEqual(
			prepared.map((result) => result.isError),
			[false, false],
		);
		const revisedDisplay = assistantMessages(harness).at(-1);
		assert.equal(revisedDisplay, `${getMessageText(prepared[1])}\n\nWould you like edits or approval?`);
		assert.notEqual(revisedDisplay, originalDisplay);
		assert.ok(revisedDisplay.includes("Repository: bastani-inc/atomic\nKind: bug"));
		assert.ok(revisedDisplay.includes("Open settings, press Tab twice, then close settings"));
		assert.ok(revisedDisplay.includes("Focus disappears after closing settings; diagnostic token [REDACTED]"));
		assert.ok(revisedDisplay.includes("Privacy scrubbed: github-token (1)."));
		assert.ok(revisedDisplay.includes("Not tested without extensions"));
		assert.ok(revisedDisplay.includes("Cause is unknown"));
		assert.ok(assistantMessages(harness).includes(originalDisplay));
		assert.ok(!transcriptText(harness).includes(secret));
		assertNoSubmission(harness);
		assert.equal(fetcher.mock.calls.length, 0);
	});

	// #2799, review 3939745622: changed direction must receive its own ordinary answer, not an approval error.
	it.each([
		["Actually, can we discuss color themes?", "Color themes can adjust contrast and distinguish syntax colors."],
		[
			"Never mind, do not post this. What does git status show?",
			"git status lists staged, unstaged, and untracked files.",
		],
	])("handles the changed direction normally: %s", async (prompt, answer) => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const harness = await createFeedbackConversationHarness();
		cleanups.push(harness.cleanup);
		harness.setResponses(prepareThenDisplay());
		await harness.session.prompt("/feedback Add keyboard navigation");
		await settleTurn(harness);
		const reviewed = assistantMessages(harness).at(-1);
		harness.setResponses([
			(context) => {
				assert.equal(getMessageText(context.messages.findLast((message) => message.role === "user")), prompt);
				return fauxAssistantMessage(answer);
			},
		]);

		await harness.session.prompt(prompt);

		assert.deepEqual(
			harness.session.messages.slice(-2).map((message) => message.role),
			["user", "assistant"],
		);
		assert.equal(assistantMessages(harness).at(-1), answer);
		assert.ok(reviewed && assistantMessages(harness).includes(reviewed));
		assert.equal(preparedResults(harness).length, 1);
		assertNoSubmission(harness);
		assert.equal(fetcher.mock.calls.length, 0);
	});

	// Preserve the original adversarial approval guard separately from normal changed-topic coverage.
	it("rejects an attempted submission after a topic change and emits an error result", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const harness = await createFeedbackConversationHarness();
		cleanups.push(harness.cleanup);
		harness.setResponses(prepareThenDisplay());
		await harness.session.prompt("/feedback Add keyboard navigation");
		await settleTurn(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("feedback_submit_issue", {
					kind: "enhancement",
					title: initialDraft.title,
					body: "### What do you want to change?\n\nAdd keyboard navigation\n\n### Why?\n\nImprove accessibility",
				}),
				{ stopReason: "toolUse" },
			),
			(context) =>
				fauxAssistantMessage(getMessageText(context.messages.findLast((message) => message.role === "toolResult"))),
		]);
		await harness.session.prompt("Actually, can we discuss color themes?");
		const result = harness.session.messages.findLast((message) => message.role === "toolResult");
		assert.equal(result?.role, "toolResult");
		assert.ok(result && result.role === "toolResult");
		assert.equal(result.toolName, "feedback_submit_issue");
		assert.equal(result.isError, true);
		assert.match(getMessageText(result), /Clear approval to post the most recent draft is required/);
		assert.equal(assistantMessages(harness).at(-1), getMessageText(result));
		assert.equal(fetcher.mock.calls.length, 0);
	});

	// #2799, review 3939745624: the retry must prepare a different draft, not just acknowledge the request.
	it("reports a model failure without losing the draft and re-prepares an ordinary retry", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const harness = await createFeedbackConversationHarness();
		cleanups.push(harness.cleanup);
		harness.setResponses(prepareThenDisplay());
		await harness.session.prompt("/feedback Add keyboard navigation");
		await settleTurn(harness);
		const displayedDraft = assistantMessages(harness).at(-1);
		assert.ok(displayedDraft);

		harness.setResponses([
			async () => {
				throw new Error("feedback model provider unavailable");
			},
		]);
		await harness.session.prompt("Please make the draft more concise.");

		const failedTurn = harness.eventsOfType("message_end").findLast((event) => event.message.role === "assistant");
		assert.ok(failedTurn?.message.role === "assistant");
		assert.equal(failedTurn.message.stopReason, "error");
		assert.equal(failedTurn.message.errorMessage, "feedback model provider unavailable");
		assert.ok(assistantMessages(harness).includes(displayedDraft));
		assert.equal(preparedResults(harness).length, 1);
		assertNoSubmission(harness);
		assert.equal(fetcher.mock.calls.length, 0);
		assertNoIssueLink(harness);

		harness.setResponses(
			prepareThenDisplay({ ...initialDraft, change: "Add keyboard shortcuts", why: "Accessibility" }),
		);
		await harness.session.prompt("Let me retry: make it shorter.");

		const prepared = preparedResults(harness);
		assert.equal(prepared.length, 2);
		assert.equal(prepared[1]?.isError, false);
		const retryDraft = assistantMessages(harness).at(-1);
		assert.equal(retryDraft, `${getMessageText(prepared[1])}\n\nWould you like edits or approval?`);
		assert.notEqual(retryDraft, displayedDraft);
		assert.ok(retryDraft.includes("### What do you want to change?\n\nAdd keyboard shortcuts"));
		assert.ok(retryDraft.includes("### Why?\n\nAccessibility"));
		assert.ok(assistantMessages(harness).includes(displayedDraft));
		assertNoSubmission(harness);
		assert.equal(fetcher.mock.calls.length, 0);
	});

	it("clarifies an unresolved request once and classifies the ordinary reply as an enhancement", async () => {
		const harness = await createFeedbackConversationHarness();
		cleanups.push(harness.cleanup);
		harness.setResponses([fauxAssistantMessage("Is this a bug you observed or a change you would like?")]);
		await harness.session.prompt("/feedback The keyboard experience");
		await settleTurn(harness);
		assert.equal(assistantMessages(harness).length, 1);
		assert.equal(assistantMessages(harness).at(-1), "Is this a bug you observed or a change you would like?");
		assert.equal(
			harness.session.messages.some((message) => message.role === "toolResult"),
			false,
		);

		harness.setResponses(prepareThenDisplay());
		await harness.session.prompt("It is a requested change for keyboard navigation.");
		assert.equal(preparedResults(harness).length, 1);
		assert.ok(assistantMessages(harness).at(-1)?.includes("Kind: enhancement"));
	});
});
