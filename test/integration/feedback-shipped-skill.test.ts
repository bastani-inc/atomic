import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import { createFeedbackConversationHarness, settleTurn } from "./feedback-conversation-harness.js";

// #2799, review 3939745620: validate the actual skill expanded into the ordinary model turn.
test("feedback conversations receive the shipped revision and approval guidance", async () => {
	const harness = await createFeedbackConversationHarness();
	try {
		let expanded = "";
		harness.setResponses([
			(context) => {
				expanded = getMessageText(context.messages.findLast((message) => message.role === "user"));
				return fauxAssistantMessage("Ready to draft.");
			},
		]);
		await harness.session.prompt("/feedback Add keyboard navigation");
		await settleTurn(harness);
		assert.match(expanded, /For every requested revision, call `feedback_prepare_issue` again/);
		assert.match(expanded, /display its exact prepared Markdown before asking again/);
		assert.match(expanded, /never retry without fresh approval/);
		assert.match(expanded, /Never launch a debugger for an enhancement/);
		assert.equal(harness.getPendingResponseCount(), 0);
	} finally {
		harness.cleanup();
	}
});
