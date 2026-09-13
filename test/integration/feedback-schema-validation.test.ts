import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import feedback from "../../packages/feedback/index.js";

// Regression for #2799, review 3998253205: malformed fields fail before draft preparation.
test("feedback string-field errors can be corrected in the next ordinary tool turn", async () => {
	const extensionsResult = await createTestExtensionsResult([feedback], process.cwd());
	const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
	try {
		const fields = { kind: "enhancement", change: "Add navigation", why: "Accessibility" };
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("feedback_prepare_issue", { ...fields, title: { text: "42" } }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The title needs to be text."),
		]);
		await harness.session.prompt("Prepare the draft");
		const invalid = harness.session.messages.find((message) => message.role === "toolResult");
		assert.equal(invalid?.isError, true);
		assert.match(getMessageText(invalid), /title: must be string/);
		assert.deepEqual(invalid?.details, {});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("feedback_prepare_issue", { ...fields, title: "42" }), {
				stopReason: "toolUse",
			}),
			(context) =>
				fauxAssistantMessage(getMessageText(context.messages.findLast((message) => message.role === "toolResult"))),
		]);
		await harness.session.prompt('Use the text "42" as the title');
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		assert.equal(results.length, 2);
		const prepared = results[1];
		assert.equal(prepared?.isError, false);
		assert.deepEqual(prepared?.details, {
			repository: { owner: "bastani-inc", repo: "atomic" },
			kind: "enhancement",
			title: "42",
			body: "### What do you want to change?\n\nAdd navigation\n\n### Why?\n\nAccessibility",
			privacySummary: [],
		});
		assert.equal(getMessageText(harness.session.messages.at(-1)), getMessageText(prepared));
	} finally {
		harness.cleanup();
	}
});
