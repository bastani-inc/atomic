import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("#7048 truncated compaction summaries", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it("rejects a length-limited branch summary instead of returning partial prose", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("partial summary", { stopReason: "length" })]);
		const result = await generateBranchSummary(
			[
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "summarize this", timestamp: Date.now() },
				},
			],
			{
				model: harness.getModel(),
				signal: new AbortController().signal,
				streamFn: harness.session.agent.streamFunction,
			},
		);

		expect(result.error).toContain("generation hit the token cap");
		expect(result.summary).toBeUndefined();
	});
});
