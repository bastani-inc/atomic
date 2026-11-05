import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import { isSubagentChildSession } from "../../src/core/agent-session-tasks.js";
import { createHarness, type Harness } from "./harness.ts";

const chunk = Array.from({ length: 300 }, (_, line) => `line ${line} of a large file the subagent read`).join("\n");

const readChunk: AgentTool = {
	name: "read_chunk",
	label: "Read chunk",
	description: "Returns a large block of text",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: chunk }], details: {} }),
};

describe("background compaction in a subagent child session (#4330)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	test("a subagent session compacts in the background while its tool turns continue (#4330)", async () => {
		const ended = new AbortController();
		const plannerCalls: boolean[] = [];
		let harness!: Harness;
		harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 32_000, maxTokens: 1_000 }],
			tools: [readChunk],
			settings: {
				compaction: { enabled: true, reserveTokens: 2_000, compression_ratio: 0.5, preserve_recent: 2 },
				retry: { enabled: false },
				sessionSummary: { enabled: false },
			},
			subagentPolicy: {
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: false,
				inheritSkills: false,
				depth: 1,
				executionEnded: ended.signal,
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						plannerCalls.push(harness.session.isCompacting);
						return { compactedText: "[User]: retained" };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "print" });
		harness.session.setActiveToolsByName(["read_chunk"]);
		assert.equal(isSubagentChildSession(harness.session), true);
		const turns = 9;
		harness.setResponses([
			...Array.from({ length: turns }, (_, index) =>
				fauxAssistantMessage([fauxToolCall("read_chunk", {}, { id: `read-${index}` })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("summary of the files"),
		]);
		await harness.session.prompt("Read the files and summarize them");
		await harness.session.awaitBackgroundCompaction();

		assert.equal(harness.session.getLastAssistantText(), "summary of the files");
		assert.ok(plannerCalls.length >= 1, "the subagent context passed the soft threshold");
		assert.ok(
			plannerCalls.every((foreground) => !foreground),
			"every planner run happened off the turn path",
		);
		assert.equal(harness.eventsOfType("compaction_start").length, 0, "no turn waited for compaction");
		const committed = harness.eventsOfType("compaction_end").filter((event) => event.background === true);
		assert.ok(committed.length >= 1, "a background result was committed at a turn boundary");
		const boundaries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		assert.equal(boundaries.length, committed.length);
		for (const boundary of boundaries) {
			assert.ok(boundary.type === "compaction" && boundary.coveredThroughEntryId !== undefined);
		}
		ended.abort();
	});
});
