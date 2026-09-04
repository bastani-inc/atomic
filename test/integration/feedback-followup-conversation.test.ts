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

const initialDraft = {
	kind: "enhancement",
	title: "Keyboard navigation",
	change: "Add keyboard navigation",
	why: "Improve accessibility",
} as const;

function prepareThenDisplay(draft: typeof initialDraft = initialDraft): FauxResponseStep[] {
	return [
		fauxAssistantMessage(fauxToolCall("feedback_prepare_issue", draft), { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			return fauxAssistantMessage(`${getMessageText(result)}\n\nWould you like edits or approval?`);
		},
	];
}

describe("feedback follow-up conversation", () => {
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
		vi.unstubAllGlobals();
	});

	it("prepares and displays a newly scrubbed draft after an ordinary revision request", async () => {
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const harness = await createFeedbackConversationHarness();
		cleanups.push(harness.cleanup);
		harness.setResponses(prepareThenDisplay());

		await harness.session.prompt("/feedback Add keyboard navigation");
		await settleTurn(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("feedback_prepare_issue", {
					...initialDraft,
					change: `Add keyboard navigation without exposing ${secret}`,
					why: "Improve keyboard-only workflows",
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				return fauxAssistantMessage(
					`## Revised feedback draft\n\n${getMessageText(result)}\n\nWould you like edits or approval?`,
				);
			},
		]);

		await harness.session.prompt("Please emphasize keyboard-only workflows and remove private credentials.");

		const prepared = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "feedback_prepare_issue",
		);
		expect(prepared).toHaveLength(2);
		const revisedDraft = assistantMessages(harness).at(-1);
		expect(revisedDraft).toContain("## Revised feedback draft");
		expect(revisedDraft).toContain("Add keyboard navigation without exposing [REDACTED]");
		expect(revisedDraft).toContain("Would you like edits or approval?");
		expect(transcriptText(harness)).not.toContain(secret);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("handles an unrelated next message normally without submitting the displayed draft", async () => {
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
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				return fauxAssistantMessage(getMessageText(result));
			},
		]);

		await harness.session.prompt("Actually, can we discuss color themes?");

		const messages = harness.session.messages;
		const latestUser = messages.findLast((message) => message.role === "user");
		expect(latestUser).toBeDefined();
		expect(getMessageText(latestUser)).toBe("Actually, can we discuss color themes?");
		expect(messages.at(-1)?.role).toBe("assistant");
		expect(getMessageText(messages.at(-1))).toContain(
			"Clear approval to post the most recent draft is required in a new ordinary user message.",
		);
		expect(
			messages.some((message) => message.role === "toolResult" && message.toolName === "feedback_submit_issue"),
		).toBe(true);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("reports a model failure without losing the draft and accepts an ordinary retry", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		const harness = await createFeedbackConversationHarness();
		cleanups.push(harness.cleanup);
		harness.setResponses(prepareThenDisplay());
		await harness.session.prompt("/feedback Add keyboard navigation");
		await settleTurn(harness);
		const displayedDraft = assistantMessages(harness).at(-1);
		expect(displayedDraft).toBeDefined();

		harness.setResponses([
			async () => {
				throw new Error("feedback model provider unavailable");
			},
		]);
		await harness.session.prompt("Please make the draft more concise.");

		const failedTurn = harness.eventsOfType("message_end").findLast((event) => event.message.role === "assistant");
		expect(failedTurn?.message).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "feedback model provider unavailable",
		});
		expect(assistantMessages(harness)).toContain(displayedDraft);
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && message.toolName === "feedback_submit_issue",
			),
		).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
		expect(transcriptText(harness)).not.toContain("https://github.com/bastani-inc/atomic/issues/");

		harness.setResponses([
			fauxAssistantMessage("The draft remains editable. Please retry the revision or request different edits."),
		]);
		await harness.session.prompt("Let me retry: make it shorter.");

		expect(harness.session.messages.at(-2)?.role).toBe("user");
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
		expect(getMessageText(harness.session.messages.at(-1))).toBe(
			"The draft remains editable. Please retry the revision or request different edits.",
		);
		expect(assistantMessages(harness)).toContain(displayedDraft);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("clarifies an unresolved request once and classifies the ordinary reply as an enhancement", async () => {
		const harness = await createFeedbackConversationHarness();
		cleanups.push(harness.cleanup);
		harness.setResponses([fauxAssistantMessage("Is this a bug you observed or a change you would like?")]);

		await harness.session.prompt("/feedback The keyboard experience");
		await settleTurn(harness);
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(assistantMessages(harness).at(-1)).toContain("Is this a bug you observed or a change you would like?");
		expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(false);

		harness.setResponses(prepareThenDisplay());
		await harness.session.prompt("It is a requested change for keyboard navigation.");

		const prepared = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "feedback_prepare_issue",
		);
		expect(prepared).toHaveLength(1);
		expect(assistantMessages(harness).at(-1)).toContain("Kind: enhancement");
	});
});
