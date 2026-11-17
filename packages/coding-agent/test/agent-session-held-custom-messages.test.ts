import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import { detachedResult, harnessPool, settlesWithin, waitForCiTurn, waitTool } from "./helpers/detached-tools.js";

const pool = harnessPool();
afterEach(async () => {
	vi.restoreAllMocks();
	await pool.cleanup();
});

const EXCLUDED_TEXT = "a display-only update while the tool is detached";
const EXCLUDED_SECOND_TEXT = "another display-only update";
const excludedCard = { customType: "display-only", content: EXCLUDED_TEXT, display: true };

for (const batch of [false, true]) {
	test.each(["steer", "followUp"] as const)(
		`a context-excluded ${batch ? "batch" : "message"} held behind a detached call stays out of every model request with %s delivery (#5318)`,
		async (deliverAs) => {
			const tool = waitTool();
			const harness = await pool.harnessWith([tool.definition]);
			const contexts: string[] = [];
			harness.session.setToolDetachment({ afterMs: 0 });
			harness.setResponses([
				waitForCiTurn("ci-1"),
				(context) => {
					contexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("CI passed");
				},
			]);
			await settlesWithin(harness.session.prompt("watch CI"));
			const settled = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type !== "agent_settled") return;
					unsubscribe();
					resolve();
				});
			});
			const options = { triggerTurn: true, excludeFromContext: true, deliverAs };
			if (batch)
				await harness.session.sendCustomMessages(
					[excludedCard, { ...excludedCard, content: EXCLUDED_SECOND_TEXT }],
					options,
				);
			else await harness.session.sendCustomMessage(excludedCard, options);
			await settlesWithin(settled);
			harness.session.takeDetachedToolCalls();
			await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

			assert.ok(contexts.length > 0, "the result continued the model turn");
			for (const context of contexts) {
				assert.equal(context.includes(EXCLUDED_TEXT), false, "the display-only text never reaches the model");
				assert.equal(context.includes(EXCLUDED_SECOND_TEXT), false);
			}
			const cards = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === excludedCard.customType);
			assert.equal(cards.length, batch ? 2 : 1, "each display-only card was saved once");
			assert.equal((await harness.session.startPendingRecovery()).replayed, 0);
		},
	);
}

test("an excluded shared-key batch keeps one display card per occurrence after failed and concurrent retries (#5318)", async () => {
	const tool = waitTool();
	const harness = await pool.harnessWith([tool.definition]);
	harness.session.setToolDetachment({ afterMs: 0 });
	harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("CI passed")]);
	await settlesWithin(harness.session.prompt("watch CI"));
	const contents = [EXCLUDED_TEXT, EXCLUDED_SECOND_TEXT, "the final excluded card"];
	const messages = contents.map((content) => ({ ...excludedCard, content }));
	const options = { triggerTurn: true, excludeFromContext: true, stageAdmissionKey: "excluded-batch" };
	const manager = harness.sessionManager;
	const append = manager.appendCustomMessageEntry.bind(manager);
	const failure = new Error("the final display card was not saved");
	let failed = false;
	vi.spyOn(manager, "appendCustomMessageEntry").mockImplementation(async (...args) => {
		if (args[1] === contents[2] && !failed) {
			failed = true;
			throw failure;
		}
		return append(...args);
	});
	await assert.rejects(harness.session.sendCustomMessages(messages, options), (error) => error === failure);
	await Promise.all([
		harness.session.sendCustomMessages(messages, options),
		harness.session.sendCustomMessages(messages, options),
	]);
	const cards = manager
		.getEntries()
		.filter((entry) => entry.type === "custom_message")
		.filter((entry) => entry.customType === excludedCard.customType);
	assert.deepEqual(
		cards.map((entry) => entry.content),
		contents,
		"each excluded card is saved once",
	);
	assert.equal(
		harness
			.eventsOfType("message_end")
			.filter((event) => event.message.role === "custom" && event.message.customType === excludedCard.customType)
			.length,
		contents.length,
		"each saved card is displayed once",
	);
	harness.session.takeDetachedToolCalls();
	await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);
	assert.equal((await harness.session.startPendingRecovery()).replayed, 0);
});
