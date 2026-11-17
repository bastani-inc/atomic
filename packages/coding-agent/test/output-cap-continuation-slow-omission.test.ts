import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { convertToLlm } from "../src/core/messages.js";
import { createHarness, fauxModel, type Harness } from "./test-harness.js";

/** The continuation probe's grace period after a length-stopped response. */
const CONTINUATION_GRACE_MS = 100;
const OUTPUT_CAP = 20;

let harness: Harness | undefined;

afterEach(() => {
	vi.restoreAllMocks();
	harness?.cleanup();
	harness = undefined;
});

test.each([
	{ stop: "at its output cap", output: OUTPUT_CAP },
	{ stop: "below its output cap, which clears the context first", output: OUTPUT_CAP / 4 },
])(
	"a response that stopped $stop is continued when recording its omission outlasts the continuation grace period (#4476)",
	async ({ output }) => {
		harness = await createHarness({
			model: { ...fauxModel, maxTokens: OUTPUT_CAP },
			settings: { compaction: { enabled: true }, sessionSummary: { enabled: false } },
			responses: [{ text: "First partial", stopReason: "length", usage: { output } }, "Final answer"],
		});
		// The session's own conversion, which turns the boundary message into the user message the model reads.
		harness.agent.convertToLlm = convertToLlm;
		const { sessionManager } = harness;
		const appendContextEdit = sessionManager.appendContextEdit.bind(sessionManager);
		// Started before the session can schedule its continuation, so it ends after that grace period.
		vi.spyOn(sessionManager, "appendContextEdit").mockImplementation(async (targetId, replacement) => {
			await new Promise((resolve) => setTimeout(resolve, 2 * CONTINUATION_GRACE_MS));
			return appendContextEdit(targetId, replacement);
		});

		await harness.session.prompt("Continue until complete");

		assert.equal(harness.faux.callCount, 2);
		assert.deepEqual(harness.eventsOfType("agent_continue_error"), []);
		// A tool declaration may follow; the last conversation message is the user's.
		assert.equal(
			harness.faux.contexts[1]?.messages.filter((message) => message.role !== "system").at(-1)?.role,
			"user",
		);
	},
);
