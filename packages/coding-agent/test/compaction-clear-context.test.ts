import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai";
import type { Message } from "@bastani/atomic-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import {
	COMPACTED_OUTPUT_MAX_TOKENS,
	compactedOutputTokenCap,
	estimateTextTokens,
	estimateTokens,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import { assertToolPairingInvariant } from "../src/core/context-tool-pairing.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const WINDOW = 1_000_000;
const RESERVE = 16_384;
const INCIDENT_TOKENS = 983_956;

async function bigHarness(settings: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	return createHarness({
		models: [{ id: "big", contextWindow: WINDOW, maxTokens: 32_000 }],
		settings: { compaction: { enabled: true, reserveTokens: RESERVE }, retry: { enabled: false } },
		...settings,
	});
}

function nonSystem(harness: Harness): Message[] {
	return convertToLlm(harness.session.messages).filter((message) => message.role !== "system");
}

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("compaction clears the context window without calling a model", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.cleanup();
		harness = undefined;
	});

	it("a ~1M-token context crossing the threshold is cleared with no model call and never degraded", async () => {
		harness = await bigHarness();
		harness.setResponses([fauxAssistantMessage("first answer")]);
		// About 984k tokens of real context: the provider reports usage from what it was sent.
		await harness.session.prompt(`start the long task\n${"word ".repeat(INCIDENT_TOKENS * 0.8)}`);
		await vi.waitFor(() => assert.equal(harness?.eventsOfType("compaction_end").length, 1));

		assert.equal(harness.faux.state.callCount, 1, "only the chat turn reached a provider");
		const [end] = harness.eventsOfType("compaction_end");
		assert.equal(end.reason, "threshold");
		assert.equal(end.errorMessage, undefined);
		assert.equal(end.result?.form, "cleared");
		assert.ok((end.result?.tokensBefore ?? 0) >= INCIDENT_TOKENS - 1_000, String(end.result?.tokensBefore));
		assert.equal(JSON.stringify(end).includes("degraded"), false);

		const context = convertToLlm(harness.session.messages);
		assert.deepEqual(
			context.map((message) => message.role),
			["system", "user"],
			"the context is exactly the system prompt and one Context cleared message",
		);
		assert.ok(textOf(context[1]).startsWith("Context cleared."));
		assert.equal(textOf(context[1]), end.result?.compactedText);
	});

	it("a provider context overflow clears the context and the retry carries exactly system + Context cleared", async () => {
		harness = await bigHarness();
		const retryContexts: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 1000500 tokens > 1000000 maximum",
			}),
			(context) => {
				retryContexts.push(context.messages.map((message) => message.role));
				return fauxAssistantMessage("recovered and continued");
			},
		]);
		await harness.session.prompt("start");
		await vi.waitFor(() => assert.equal(harness?.session.getLastAssistantText(), "recovered and continued"));

		const [end] = harness.eventsOfType("compaction_end");
		assert.equal(end.reason, "overflow");
		assert.equal(end.result?.form, "cleared");
		assert.equal(harness.faux.state.callCount, 2, "the failed request and its one retry; compaction added none");
		assert.deepEqual(retryContexts, [["system", "user"]]);
	});

	it("manual /compact instructions reach the boundary message, with no model call", async () => {
		harness = await bigHarness();
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("do the thing");
		const calls = harness.faux.state.callCount;

		const result = await harness.session.compact({ query: "keep the parser decisions" });

		assert.equal(harness.faux.state.callCount, calls);
		assert.equal(result.form, "cleared");
		assert.equal(result.parameters.query, "keep the parser decisions");
		assert.ok(
			result.compactedText.includes("Compaction instructions from the user:\nkeep the parser decisions"),
			result.compactedText,
		);
		assert.ok(result.compactedText.trimEnd().endsWith("Then continue the task."));
	});

	it("the recovery prompt orders keepContext spans first, then objectives, constraints and identifiers", async () => {
		harness = await bigHarness();
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("task");
		const { compactedText } = await harness.session.compact();
		const keep = compactedText.indexOf("Every <keepContext> span, verbatim");
		const objectives = compactedText.indexOf("The user's objectives and latest requests");
		assert.ok(keep > 0 && objectives > keep, compactedText);
		for (const phrase of [
			"constraints and prohibitions",
			"branches, worktrees, pull requests, run ids, file paths",
			"open work and blockers",
			"Prefer the most recent records",
			"Copy what you need verbatim",
		]) {
			assert.ok(compactedText.includes(phrase), `missing "${phrase}"`);
		}
	});

	it("removed compact options are accepted and ignored", async () => {
		harness = await bigHarness();
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("task");
		const legacy = { compression_ratio: 0.3, preserve_recent: 4 } as Parameters<Harness["session"]["compact"]>[0];
		const result = await harness.session.compact(legacy);
		assert.equal(result.form, "cleared");
		assert.deepEqual(nonSystem(harness).length, 1);
	});

	it("a context that was just cleared is not cleared again, so compaction cannot loop", async () => {
		harness = await bigHarness();
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("task");
		await harness.session.compact();
		const boundaries = () =>
			harness?.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
		assert.equal(boundaries(), 1);

		await assert.rejects(harness.session.compact(), /Nothing to compact/u);
		const internals = harness.session as AgentSessionInternalSurface;
		assert.equal(await internals._runAutoCompaction("threshold", false), "not_compactable");
		assert.equal(boundaries(), 1);
	});

	it("a cleared context with the largest compacted text stays below the automatic trigger", async () => {
		harness = await bigHarness();
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("task");
		const { compactedText } = await harness.session.compact();
		const trigger = WINDOW - RESERVE;
		const cap = compactedOutputTokenCap(trigger);
		assert.ok(cap <= COMPACTED_OUTPUT_MAX_TOKENS);
		const cleared = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		assert.ok(
			!shouldCompact(cleared + estimateTextTokens(compactedText) + cap, WINDOW, {
				enabled: true,
				reserveTokens: RESERVE,
			}),
		);
		for (const window of [32_000, 128_000, 200_000]) {
			const smallTrigger = window - RESERVE;
			assert.ok(compactedOutputTokenCap(smallTrigger) * 2 <= smallTrigger, `cap for a ${window} window`);
		}
	});

	it("an automatic trigger does not clear a context whose system prompt alone reaches the trigger", async () => {
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 4_000, maxTokens: 500 }],
			settings: { compaction: { enabled: true, reserveTokens: 1_000 }, retry: { enabled: false } },
			systemPrompt: "rule ".repeat(4_000),
		});
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("task");
		const internals = harness.session as AgentSessionInternalSurface;
		assert.equal(await internals._runAutoCompaction("threshold", false), "not_compactable");
		assert.equal(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
		const manual = await harness.session.compact();
		assert.equal(manual.form, "cleared", "a manual request still clears");
	});

	it("a pending tool call keeps its turn after the boundary, so no tool result is ever orphaned", async () => {
		harness = await bigHarness();
		const manager = harness.sessionManager;
		const model = harness.getModel();
		await manager.appendMessage({ role: "user", content: "run the slow tool", timestamp: 1 });
		const call = fauxToolCall("slow_tool", {}, { id: "call-pending" });
		await manager.appendMessage({ ...fauxAssistantMessage([call], { stopReason: "toolUse" }), model: model.id });
		harness.session.agent.state.messages = manager.buildSessionContext().messages;

		await harness.session.compact();
		const projected = manager.buildSessionContext().messages;
		assert.deepEqual(
			projected.map((message) => message.role),
			["custom", "assistant"],
			"the boundary sits before the turn that waits on its result",
		);
		await manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-pending",
			toolName: "slow_tool",
			content: [{ type: "text", text: "late result" }],
			isError: false,
			timestamp: 3,
		});
		const after = convertToLlm(manager.buildSessionContext().messages);
		assert.doesNotThrow(() => assertToolPairingInvariant(after));
		assert.deepEqual(
			after.map((message) => message.role),
			["user", "assistant", "toolResult"],
		);
	});

	it("with a tool call still pending, compacting again finds nothing new instead of clearing twice", async () => {
		const seen: number[] = [];
		harness = await createHarness({
			models: [{ id: "big", contextWindow: WINDOW, maxTokens: 32_000 }],
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						seen.push(event.preparation.regionEntryIds.length);
					});
				},
			],
		});
		const manager = harness.sessionManager;
		await manager.appendMessage({ role: "user", content: "run the slow tool", timestamp: 1 });
		const call = fauxToolCall("slow_tool", {}, { id: "call-pending" });
		await manager.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
		harness.session.agent.state.messages = manager.buildSessionContext().messages;

		await harness.session.compact();
		await assert.rejects(harness.session.compact(), /Nothing to compact/u);
		assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
		assert.deepEqual(seen, [1], "the hook saw the conversation once, not the same region twice");
	});

	it("compaction is planned only once streaming has stopped", async () => {
		const streamingAtPlan: boolean[] = [];
		harness = await createHarness({
			models: [{ id: "big", contextWindow: WINDOW, maxTokens: 32_000 }],
			settings: { compaction: { enabled: true, reserveTokens: RESERVE }, retry: { enabled: false } },
			fauxProvider: { tokensPerSecond: 20 },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (_event, ctx) => {
						streamingAtPlan.push(!ctx.isIdle());
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("a long streamed answer ".repeat(20))]);
		const prompting = harness.session.prompt("go");
		await vi.waitFor(() => assert.equal(harness?.session.isStreaming, true));
		const compacting = harness.session.compact();
		await Promise.allSettled([prompting, compacting]);
		assert.deepEqual(streamingAtPlan, [false]);
		const branch = harness.sessionManager.getBranch();
		const boundaryIndex = branch.findIndex((entry) => entry.type === "compaction");
		assert.ok(boundaryIndex > 0);
		assert.ok(
			branch.slice(0, boundaryIndex).some((entry) => entry.type === "message" && entry.message.role === "assistant"),
			"the interrupted assistant message was written before the boundary",
		);
	});
});
