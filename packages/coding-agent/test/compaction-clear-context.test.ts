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
	findUnansweredToolCall,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import { assertToolPairingInvariant } from "../src/core/context-tool-pairing.ts";
import { convertToLlm } from "../src/core/messages.ts";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
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
		const nextRequest: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage("first answer"),
			(context) => {
				nextRequest.push(context.messages.map((message) => message.role));
				return fauxAssistantMessage("second answer");
			},
		]);
		// About 984k tokens of real context: the provider reports usage from what it was sent.
		await harness.session.prompt(`start the long task\n${"word ".repeat(INCIDENT_TOKENS * 0.8)}`);
		assert.equal(harness.eventsOfType("compaction_end").length, 0, "the answer stays in context for its readers");
		let clearedContext: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end")
				clearedContext = convertToLlm(harness!.session.messages).map((m) => m.role);
		});

		await harness.session.prompt("continue");

		assert.equal(harness.faux.state.callCount, 2, "only the two chat turns reached a provider");
		const [end] = harness.eventsOfType("compaction_end");
		assert.equal(end.reason, "threshold");
		assert.equal(end.errorMessage, undefined);
		assert.equal(end.result?.form, "cleared");
		assert.ok((end.result?.tokensBefore ?? 0) >= INCIDENT_TOKENS - 1_000, String(end.result?.tokensBefore));
		assert.equal(JSON.stringify(end).includes("degraded"), false);
		assert.deepEqual(clearedContext, ["system", "user"], "right after the clear: system prompt and one message");
		assert.deepEqual(nextRequest, [["system", "user", "user"]], "the next request adds only the new prompt");
		const boundary = convertToLlm(harness.session.messages)[1];
		assert.ok(textOf(boundary).startsWith("Context cleared."));
		assert.equal(textOf(boundary), end.result?.compactedText);
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

	it("no boundary is written while a tool call waits for its result, so none is ever orphaned", async () => {
		harness = await bigHarness();
		const manager = harness.sessionManager;
		await manager.appendMessage({ role: "user", content: "run the slow tool", timestamp: 1 });
		const call = fauxToolCall("slow_tool", {}, { id: "call-pending" });
		await manager.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
		harness.session.agent.state.messages = manager.buildSessionContext().messages;
		const internals = harness.session as AgentSessionInternalSurface;

		await assert.rejects(harness.session.compact(), /still waiting for its result/u);
		assert.equal(await internals._runAutoCompaction("threshold", false), "not_compactable");
		assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);

		await manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-pending",
			toolName: "slow_tool",
			content: [{ type: "text", text: "late result" }],
			isError: false,
			timestamp: 3,
		});
		harness.session.agent.state.messages = manager.buildSessionContext().messages;
		await harness.session.compact();
		const boundary = manager.getEntries().find((entry) => entry.type === "compaction");
		assert.equal(boundary?.type === "compaction" ? boundary.coveredThroughEntryId : "missing", undefined);
		const after = convertToLlm(manager.buildSessionContext().messages);
		assert.doesNotThrow(() => assertToolPairingInvariant(after));
		assert.deepEqual(
			after.map((message) => message.role),
			["user"],
			"the call and its result are both behind the boundary",
		);
	});

	it("compaction is planned only once streaming has stopped", async () => {
		const streamingAtPlan: boolean[] = [];
		harness = await createHarness({
			models: [{ id: "big", contextWindow: WINDOW, maxTokens: 32_000 }],
			settings: { compaction: { enabled: true, reserveTokens: RESERVE }, retry: { enabled: false } },
			fauxProvider: { tokensPerSecond: 20 },
			extensionFactories: [
				(atomic) => {
					atomic.on("session_before_compact", (_event, ctx) => {
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

	it("a manual compaction during a streamed tool call clears after the abort, leaving no call waiting", async () => {
		harness = await createHarness({
			models: [{ id: "big", contextWindow: WINDOW, maxTokens: 32_000 }],
			settings: { compaction: { enabled: true, reserveTokens: RESERVE }, retry: { enabled: false } },
			fauxProvider: { tokensPerSecond: 20 },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a/".repeat(400) }, { id: "streamed-call" })], {
				stopReason: "toolUse",
			}),
		]);
		let compacting: Promise<unknown> | undefined;
		let callsAtCompact = 0;
		harness.session.subscribe((event) => {
			if (
				compacting === undefined &&
				event.type === "message_update" &&
				event.message.role === "assistant" &&
				event.message.content.some((block) => block.type === "toolCall")
			) {
				callsAtCompact = harness!.faux.state.callCount;
				compacting = harness!.session.compact();
			}
		});
		const prompting = harness.session.prompt("go");
		await vi.waitFor(() => assert.ok(compacting !== undefined));
		const [, compacted] = await Promise.allSettled([prompting, compacting!]);

		assert.equal(compacted.status, "fulfilled", compacted.status === "rejected" ? String(compacted.reason) : "");
		assert.equal((compacted as PromiseFulfilledResult<{ form: string }>).value.form, "cleared");
		assert.equal(harness.faux.state.callCount, callsAtCompact, "the compaction made no model call");
		const branch = harness.sessionManager.getBranch();
		const boundaries = branch.flatMap((entry, index) => (entry.type === "compaction" ? [index] : []));
		assert.equal(boundaries.length, 1);
		const before = branch.slice(0, boundaries[0]);
		const aborted = before.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(aborted?.type === "message" && aborted.message.role === "assistant");
		assert.equal(aborted.message.stopReason, "aborted");
		assert.ok(aborted.message.content.some((block) => block.type === "toolCall"));
		const context = nonSystem(harness);
		assert.equal(context.length, 1);
		assert.ok(textOf(context[0]).startsWith("Context cleared."));
		assert.doesNotThrow(() => assertToolPairingInvariant(convertToLlm(harness!.session.messages)));
	});

	it("aborting a streamed tool call and then compacting clears the context", async () => {
		harness = await createHarness({
			models: [{ id: "big", contextWindow: WINDOW, maxTokens: 32_000 }],
			settings: { compaction: { enabled: true, reserveTokens: RESERVE }, retry: { enabled: false } },
			fauxProvider: { tokensPerSecond: 20 },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a/".repeat(400) }, { id: "aborted-call" })], {
				stopReason: "toolUse",
			}),
		]);
		let aborting: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (
				aborting === undefined &&
				event.type === "message_update" &&
				event.message.role === "assistant" &&
				event.message.content.some((block) => block.type === "toolCall")
			) {
				aborting = harness!.session.abort();
			}
		});
		const prompting = harness.session.prompt("go");
		await vi.waitFor(() => assert.ok(aborting !== undefined));
		await Promise.allSettled([prompting, aborting!]);

		const result = await harness.session.compact();
		assert.equal(result.form, "cleared");
		const branch = harness.sessionManager.getBranch();
		const boundaries = branch.flatMap((entry, index) => (entry.type === "compaction" ? [index] : []));
		assert.equal(boundaries.length, 1);
		const aborted = branch
			.slice(0, boundaries[0])
			.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.ok(aborted?.type === "message" && aborted.message.role === "assistant");
		assert.equal(aborted.message.stopReason, "aborted");
		assert.ok(aborted.message.content.some((block) => block.type === "toolCall"));
		assert.doesNotThrow(() => assertToolPairingInvariant(convertToLlm(harness!.session.messages)));
	});
});

describe("which tool calls still wait for a result", () => {
	let next = 0;
	function entry(
		message: SessionEntry extends infer E ? (E extends { type: "message" } ? E["message"] : never) : never,
	) {
		next += 1;
		return {
			type: "message",
			id: `e${next}`,
			parentId: next === 1 ? null : `e${next - 1}`,
			timestamp: new Date(next).toISOString(),
			message,
		} as SessionEntry;
	}
	const user = () => entry({ role: "user", content: "go", timestamp: 1 });
	const call = (stopReason: "toolUse" | "aborted" | "error" | "length") =>
		entry(fauxAssistantMessage([fauxToolCall("read", { path: "a" }, { id: "call-1" })], { stopReason }));
	const result = () =>
		entry({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		});

	it("an aborted or errored call was never executed and waits for nothing", () => {
		assert.equal(findUnansweredToolCall([user(), call("aborted")]), undefined);
		assert.equal(findUnansweredToolCall([user(), call("error")]), undefined);
	});

	it("a call from a completed tool-use turn waits until its result arrives, including when detached behind a later entry", () => {
		assert.equal(findUnansweredToolCall([user(), call("toolUse")]), 1);
		assert.equal(findUnansweredToolCall([user(), call("toolUse"), result()]), undefined);
		assert.equal(findUnansweredToolCall([user(), call("length")]), 1);
		const detached = call("toolUse");
		assert.equal(findUnansweredToolCall([user(), detached, user()], detached.id), 1);
	});
});
