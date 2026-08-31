import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

const largeResultTool: AgentTool = {
	name: "large_result",
	label: "Large result",
	description: "Returns a controlled large result",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "text", text: "x".repeat(480) }],
		details: {},
	}),
};

const terminatingLargeResultTool: AgentTool = {
	...largeResultTool,
	execute: async () => ({
		content: [{ type: "text", text: "x".repeat(480) }],
		details: {},
		terminate: true,
	}),
};

const compactOffline: ExtensionFactory = (pi) => {
	pi.on("session_before_compact", () => ({ compactedText: "[User]: retained" }));
};
function createPostToolCompactionGate() {
	let signalStarted!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const factory: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", async (event) => {
			if (event.reason === "manual") return { compactedText: "[User]: retained" };
			assert.equal(event.reason, "threshold");
			signalStarted();
			await released;
			return { compactedText: "[User]: retained" };
		});
	};
	return { factory, started, release: () => release() };
}

const longPrompt = Array.from({ length: 24 }, (_, index) => `context line ${index + 1}`).join("\n");

async function wireHarness(harness: Harness): Promise<void> {
	await harness.session.bindExtensions({});
	harness.session.setActiveToolsByName(["large_result"]);
	harness.agent.convertToLlm = convertToLlm;
}

describe("post-tool compaction preflight", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	it("compacts a tool-expanded context before the next provider request without starting another continuation", async () => {
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-1", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				"completed after compaction",
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [compactOffline],
		});
		harnesses.push(harness);
		await wireHarness(harness);
		const continueSpy = vi.spyOn(harness.agent, "continue");

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toEqual([
			expect.objectContaining({ reason: "threshold", midTurn: true }),
		]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: false, willRetry: false, midTurn: true }),
		]);
		// The kept tail is concatenated into the boundary string instead of being replayed
		// as separate assistant/toolResult blocks.
		expect(harness.faux.contexts[1]?.messages.map((message) => message.role)).toEqual(["user"]);
		expect(harness.faux.contexts[1]?.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("[User]: retained") }],
		});
		expect(harness.faux.contexts[1]?.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("[Tool result]: ") }],
		});
		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.session.getLastAssistantText()).toBe("completed after compaction");
	});
	test("records and clears the active reason for mid-turn post-tool compaction", async () => {
		const gate = createPostToolCompactionGate();
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-post-tool-reason", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				"completed after compaction",
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [gate.factory],
		});
		harnesses.push(harness);
		await wireHarness(harness);

		const prompt = harness.session.prompt(longPrompt);
		await gate.started;
		assert.equal(harness.session.compactionReason, "threshold");
		gate.release();
		await prompt;
		assert.equal(harness.session.compactionReason, undefined);
	});

	it("includes steering queued during post-tool compaction in the resumed request", async () => {
		const gate = createPostToolCompactionGate();
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-post-tool-steering", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				"completed after steering",
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [gate.factory],
		});
		harnesses.push(harness);
		await wireHarness(harness);

		const prompt = harness.session.prompt(longPrompt);
		await gate.started;
		await harness.session.steer("change direction");
		gate.release();
		await prompt;

		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(JSON.stringify(harness.faux.contexts[1]?.messages)).toContain("change direction");
		expect(harness.faux.callCount).toBe(2);
	});

	it("lets manual compaction take over a gated post-tool preflight", async () => {
		const gate = createPostToolCompactionGate();
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-post-tool-takeover", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				"completed after compaction",
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [gate.factory],
		});
		harnesses.push(harness);
		await wireHarness(harness);

		const prompt = harness.session.prompt(longPrompt);
		await gate.started;
		const manual = harness.session.compact();
		gate.release();
		const [, manualResult] = await Promise.all([prompt, manual]);

		expect(manualResult.compactedText).toBe("[User]: retained");
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold", "manual"]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: true, midTurn: true, manualTakeoverPending: true }),
			expect.objectContaining({ reason: "manual", aborted: false }),
		]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	// Regression (greptile P1 on PR #2136): ownership was published and
	// `compaction_start` emitted BEFORE the `try`, so a synchronous subscriber
	// that threw skipped the `finally` entirely. `_autoCompactionAbortController`
	// and `_compactionReason` stayed set, wedging every later threshold
	// compaction behind "another automatic compaction is already active" and
	// pinning the compaction label on attached clients forever.
	test("clears compaction ownership when a compaction_start listener throws", async () => {
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-post-tool-throw", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				"completed after compaction",
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [compactOffline],
		});
		harnesses.push(harness);
		await wireHarness(harness);

		// Drive the production preflight directly: the agent loop absorbs a throwing
		// listener into its own error handling, which would mask whether ownership
		// was released. Greptile's harness reproduced it at this level too.
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "compaction_start") throw new Error("listener exploded");
		});

		const oversized = Array.from({ length: 400 }, (_, index) => ({
			role: "user" as const,
			content: [{ type: "text" as const, text: `filler line ${index} ${longPrompt}` }],
		}));

		await assert.rejects(
			harness.session._preflightPostToolContext(oversized),
			/listener exploded/,
			"the throwing compaction_start listener must propagate",
		);
		unsubscribe();

		// The throw must not leave the session owning a compaction that never ran.
		assert.equal(harness.session.compactionReason, undefined);
		assert.equal(harness.session.isCompacting, false);

		// And the next threshold compaction must not be rejected as already active.
		await assert.doesNotReject(harness.session._preflightPostToolContext(oversized));
	});

	// Regression: the compaction preflight used to return `agent.state.messages`, whose
	// getter hands back the live internal array. The agent loop adopted it as
	// `currentContext.messages`, so from the following turn on both `runLoop` and the
	// `message_end` reducer appended to the same array. Every message was duplicated and
	// the provider rejected two `tool_result` blocks sharing one `tool_use` id with a 400.
	it("keeps turns after a mid-turn parallel-tool compaction structurally valid", async () => {
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [
						{ id: "call-a", name: "large_result", args: {} },
						{ id: "call-b", name: "large_result", args: {} },
						{ id: "call-c", name: "large_result", args: {} },
					],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				{
					toolCalls: [{ id: "call-d", name: "large_result", args: {} }],
					usage: { input: 100, output: 10, totalTokens: 110 },
				},
				"completed after compaction",
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [compactOffline],
		});
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(3);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		// The turn after the boundary carries the new call and exactly one result for it.
		expect(harness.faux.contexts[2]?.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
		for (const context of harness.faux.contexts) {
			const toolResultIds = context.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => (message as { toolCallId: string }).toolCallId);
			expect(toolResultIds).toEqual([...new Set(toolResultIds)]);
			const toolCallIds = context.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) =>
					(message.content as Array<{ type: string; id?: string }>)
						.filter((block) => block.type === "toolCall")
						.map((block) => block.id as string),
				);
			expect(toolCallIds).toEqual([...new Set(toolCallIds)]);
		}
		expect(harness.session.getLastAssistantText()).toBe("completed after compaction");
	});

	it("leaves below-threshold tool turns unchanged", async () => {
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-below", name: "large_result", args: {} }],
					usage: { input: 550, output: 20, totalTokens: 570 },
				},
				"completed without compaction",
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [compactOffline],
		});
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.faux.contexts[1]?.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
		expect(harness.faux.contexts[1]?.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: longPrompt }],
		});
	});

	it.each([
		{
			name: "cancellation",
			extension: ((pi) => pi.on("session_before_compact", () => ({ cancel: true }))) satisfies ExtensionFactory,
			aborted: true,
			error: "cancelled",
		},
		{
			name: "failure",
			extension: ((pi) =>
				pi.on("session_before_compact", () => ({ compactedText: "  \n" }))) satisfies ExtensionFactory,
			aborted: false,
			error: "No compacted text provided",
		},
	])(
		"surfaces post-tool compaction $name without sending the follow-up request",
		async ({ extension, aborted, error }) => {
			const harness = await createHarnessWithExtensions({
				contextWindow: 1_000,
				settings: {
					compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
				},
				responses: [
					{
						toolCalls: [{ id: "call-fail", name: "large_result", args: {} }],
						usage: { input: 700, output: 20, totalTokens: 720 },
					},
					"must not be requested",
				],
				baseToolsOverride: { large_result: largeResultTool },
				extensionFactories: [extension],
			});
			harnesses.push(harness);
			await wireHarness(harness);

			await harness.session.prompt(longPrompt);

			expect(harness.faux.callCount).toBe(1);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end")).toEqual([
				expect.objectContaining({ reason: "threshold", aborted, willRetry: false }),
			]);
			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "error",
				errorMessage: expect.stringContaining(error),
			});
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		},
	);

	it("does not route a retryable preflight failure into retry, fallback, or continuation", async () => {
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-retryable-failure", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [compactOffline],
		});
		harnesses.push(harness);
		await wireHarness(harness);
		const internals = harness.session as unknown as {
			_applyVerbatimCompaction(options: object): Promise<never>;
		};
		vi.spyOn(internals, "_applyVerbatimCompaction").mockRejectedValue(new Error("429 rate limit"));
		const continueSpy = vi.spyOn(harness.agent, "continue");

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("model_fallback_start")).toHaveLength(0);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("429 rate limit"),
		});
	});

	it("does not compact a terminating tool batch with no follow-up provider request", async () => {
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-terminate", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
			],
			baseToolsOverride: { large_result: terminatingLargeResultTool },
			extensionFactories: [compactOffline],
		});
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("checks stop before skipping preparation for a terminating tool batch", async () => {
		const order: string[] = [];
		let stopContext:
			| Parameters<NonNullable<import("@earendil-works/pi-agent-core").Agent["shouldStopAfterTurn"]>>[0]
			| undefined;
		const harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ id: "call-terminate-order", name: "large_result", args: {} }] }],
			baseToolsOverride: { large_result: terminatingLargeResultTool },
			configureAgent: (agent) => {
				agent.shouldStopAfterTurn = (context) => {
					order.push("shouldStopAfterTurn");
					stopContext = context;
					return false;
				};
				agent.prepareNextTurnWithContext = () => {
					order.push("prepareNextTurnWithContext");
					return undefined;
				};
			},
		});
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt("terminate after the tool");

		expect(order).toEqual(["shouldStopAfterTurn"]);
		expect(harness.faux.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(stopContext?.message.content).toEqual([
			expect.objectContaining({ type: "toolCall", id: "call-terminate-order" }),
		]);
		expect(stopContext?.toolResults).toHaveLength(1);
		expect(stopContext?.context.messages.at(-1)).toMatchObject({
			role: "toolResult",
			toolCallId: "call-terminate-order",
		});
	});

	it("keeps the completed-turn stop result across an out-of-band stop call", async () => {
		let agent!: import("@earendil-works/pi-agent-core").Agent;
		let completedTurnStopCalls = 0;
		let outOfBandStopCalls = 0;
		let outOfBandResult: boolean | undefined;
		const harness = await createHarnessWithExtensions({
			responses: [
				{ toolCalls: [{ id: "call-out-of-band-stop", name: "large_result", args: {} }] },
				"completed after preparation",
			],
			baseToolsOverride: { large_result: largeResultTool },
			configureAgent: (configuredAgent) => {
				agent = configuredAgent;
				agent.shouldStopAfterTurn = (context) => {
					if (context.newMessages === outOfBandContext?.newMessages) {
						outOfBandStopCalls++;
						return true;
					}
					completedTurnStopCalls++;
					return false;
				};
				agent.prepareNextTurnWithContext = async (context) => {
					outOfBandContext = { ...context, newMessages: context.newMessages.slice() };
					outOfBandResult = await agent.shouldStopAfterTurn?.(outOfBandContext);
					return undefined;
				};
			},
		});
		let outOfBandContext: import("@earendil-works/pi-agent-core").ShouldStopAfterTurnContext | undefined;
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt("run the tool and continue");

		expect(outOfBandResult).toBe(true);
		expect(outOfBandStopCalls).toBe(1);
		expect(completedTurnStopCalls).toBe(2);
		expect(harness.faux.callCount).toBe(2);
	});

	it("compacts before caller preparation and preserves the caller's complete replacement context", async () => {
		const preparedEarlierSentinel = "[caller-prepared earlier context]";
		const preparedTailOne = "[caller-prepared tail one]";
		const preparedTailTwo = "[caller-prepared tail two]";
		const order: string[] = [];
		let toolTurnStopCalls = 0;
		let finalTurnStopCalls = 0;
		let prepareCalls = 0;
		let completedTurnContext: import("@earendil-works/pi-agent-core").AgentContext | undefined;
		let completedTurnSnapshot = "";
		let callerInputContext: import("@earendil-works/pi-agent-core").AgentContext | undefined;
		let callerOutputContext: import("@earendil-works/pi-agent-core").AgentContext | undefined;
		let compactionInput = "";
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-continue-order", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				{ text: "completed after preparation", beforeEmit: () => order.push("provider") },
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						order.push("compaction");
						return { compactedText: "[User]: retained" };
					});
				},
			],
			configureAgent: (agent) => {
				agent.shouldStopAfterTurn = (context) => {
					if (context.toolResults.length > 0) {
						toolTurnStopCalls++;
						completedTurnContext = context.context;
						completedTurnSnapshot = JSON.stringify(context.context.messages);
						order.push("shouldStopAfterTurn");
					} else {
						finalTurnStopCalls++;
					}
					return false;
				};
				agent.prepareNextTurnWithContext = (context) => {
					prepareCalls++;
					order.push("prepareNextTurnWithContext");
					callerInputContext = context.context;
					const compactedInput = JSON.stringify(context.context.messages);
					expect(compactedInput).toContain("[User]: retained");
					expect(compactedInput).not.toContain(preparedEarlierSentinel);
					const preparedMessages: import("@earendil-works/pi-agent-core").AgentMessage[] = [
						{
							role: "user",
							content: [{ type: "text", text: preparedEarlierSentinel }],
							timestamp: 1,
						},
						...context.context.messages,
						{
							role: "user",
							content: [{ type: "text", text: preparedTailOne }],
							timestamp: 2,
						},
						{
							role: "user",
							content: [{ type: "text", text: preparedTailTwo }],
							timestamp: 3,
						},
					];
					callerOutputContext = { ...context.context, messages: preparedMessages };
					expect(callerOutputContext).not.toBe(context.context);
					expect(preparedMessages).not.toBe(context.context.messages);
					return { context: callerOutputContext };
				};
			},
		});
		const internal = harness.session as unknown as {
			_preflightPostToolContext(
				messages: import("@earendil-works/pi-agent-core").AgentMessage[],
				signal?: AbortSignal,
			): Promise<import("@earendil-works/pi-agent-core").AgentMessage[]>;
		};
		const originalPreflight = internal._preflightPostToolContext.bind(harness.session);
		internal._preflightPostToolContext = async (messages, signal) => {
			compactionInput = JSON.stringify(messages);
			return originalPreflight(messages, signal);
		};
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt(longPrompt);

		expect(order).toEqual(["shouldStopAfterTurn", "compaction", "prepareNextTurnWithContext", "provider"]);
		expect(compactionInput).not.toContain(preparedEarlierSentinel);
		expect(toolTurnStopCalls).toBe(1);
		expect(finalTurnStopCalls).toBe(1);
		expect(prepareCalls).toBe(1);
		const resumedText = JSON.stringify(harness.faux.contexts[1]?.messages);
		expect(resumedText).toContain(preparedEarlierSentinel);
		expect(resumedText).toContain("[User]: retained");
		expect(resumedText).toContain(preparedTailOne);
		expect(resumedText).toContain(preparedTailTwo);
		expect(resumedText.indexOf(preparedEarlierSentinel)).toBeLessThan(resumedText.indexOf(preparedTailOne));
		expect(JSON.stringify(completedTurnContext?.messages)).toBe(completedTurnSnapshot);
		expect(JSON.stringify(completedTurnContext?.messages)).not.toContain(preparedEarlierSentinel);
		expect(JSON.stringify(callerInputContext?.messages)).not.toContain(preparedEarlierSentinel);
		expect(JSON.stringify(callerOutputContext?.messages)).toContain(preparedEarlierSentinel);
	});

	it("passes the compacted visible tool pair through caller preparation while excluding hidden additions", async () => {
		const preparedVisibleSentinel = "[caller prepared visible message]";
		const excludedTailSentinel = "[excluded prepared tail]";
		let callerInputContext: import("@earendil-works/pi-agent-core").AgentContext | undefined;
		let compactionInput = "";
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-visible-tail", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				"completed after visible-tail compaction",
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [compactOffline],
			configureAgent: (agent) => {
				agent.prepareNextTurnWithContext = (context) => {
					callerInputContext = context.context;
					const compactedText = JSON.stringify(context.context.messages);
					expect(compactedText).toContain("[Assistant tool calls]: large_result()");
					expect(compactedText).toContain("[Tool result]: ");
					return {
						context: {
							...context.context,
							messages: [
								...context.context.messages,
								{
									role: "user",
									content: [{ type: "text", text: preparedVisibleSentinel }],
									timestamp: 1,
								},
								{
									role: "custom",
									customType: "excluded-prepared-tail",
									content: excludedTailSentinel,
									display: false,
									excludeFromContext: true,
									timestamp: 2,
								},
							],
						},
					};
				};
			},
		});
		const internal = harness.session as unknown as {
			_preflightPostToolContext(
				messages: import("@earendil-works/pi-agent-core").AgentMessage[],
				signal?: AbortSignal,
			): Promise<import("@earendil-works/pi-agent-core").AgentMessage[]>;
		};
		const originalPreflight = internal._preflightPostToolContext.bind(harness.session);
		internal._preflightPostToolContext = async (messages, signal) => {
			compactionInput = JSON.stringify(messages);
			return originalPreflight(messages, signal);
		};
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt(longPrompt);

		expect(compactionInput).not.toContain(preparedVisibleSentinel);
		expect(compactionInput).not.toContain(excludedTailSentinel);
		const resumedText = JSON.stringify(harness.faux.contexts[1]?.messages);
		expect(resumedText).toContain("[Assistant tool calls]: large_result()");
		expect(resumedText).toContain("[Tool result]: ");
		expect(resumedText).toContain(preparedVisibleSentinel);
		expect(resumedText).not.toContain(excludedTailSentinel);
		expect(JSON.stringify(callerInputContext?.messages)).not.toContain(preparedVisibleSentinel);
		expect(JSON.stringify(callerInputContext?.messages)).not.toContain(excludedTailSentinel);
	});

	it("skips preparation when the stop callback ends the run", async () => {
		let stopCalls = 0;
		let prepareCalls = 0;
		const harness = await createHarnessWithExtensions({
			responses: ["finished"],
			configureAgent: (agent) => {
				agent.shouldStopAfterTurn = () => {
					stopCalls++;
					return true;
				};
				agent.prepareNextTurnWithContext = () => {
					prepareCalls++;
					return undefined;
				};
			},
		});
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt("finish without a tool");

		expect(stopCalls).toBe(1);
		expect(prepareCalls).toBe(0);
		expect(harness.faux.callCount).toBe(1);
	});

	it.each(["steer", "followUp"] as const)(
		"preserves queued %s work without continuing after the stop callback ends the run",
		async (delivery) => {
			let signalStopStarted!: () => void;
			const stopStarted = new Promise<void>((resolve) => {
				signalStopStarted = resolve;
			});
			let releaseStop!: () => void;
			const stopReleased = new Promise<void>((resolve) => {
				releaseStop = resolve;
			});
			let stopCalls = 0;
			const harness = await createHarnessWithExtensions({
				responses: ["finished", "explicit run completed", "follow-up completed"],
				configureAgent: (agent) => {
					agent.shouldStopAfterTurn = async () => {
						stopCalls++;
						if (stopCalls > 1) return false;
						signalStopStarted();
						await stopReleased;
						return true;
					};
				},
			});
			harnesses.push(harness);
			await wireHarness(harness);

			const prompt = harness.session.prompt("finish at the stop boundary");
			await stopStarted;
			await harness.session[delivery]("queued during the stop callback");
			releaseStop();
			await prompt;

			expect(harness.faux.callCount).toBe(1);
			const queuedMessages = () =>
				delivery === "steer" ? harness.session.getSteeringMessages() : harness.session.getFollowUpMessages();
			expect(queuedMessages()).toEqual(["queued during the stop callback"]);

			await harness.session.prompt("explicitly start a new run");

			expect(harness.faux.callCount).toBe(delivery === "steer" ? 2 : 3);
			expect(queuedMessages()).toEqual([]);
		},
	);

	it("checks stop once and skips preparation after a final response with no queued work", async () => {
		let stopCalls = 0;
		let prepareCalls = 0;
		const harness = await createHarnessWithExtensions({
			responses: ["finished"],
			configureAgent: (agent) => {
				agent.shouldStopAfterTurn = () => {
					stopCalls++;
					return false;
				};
				agent.prepareNextTurnWithContext = () => {
					prepareCalls++;
					return undefined;
				};
			},
		});
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt("finish without queued work");

		expect(stopCalls).toBe(1);
		expect(prepareCalls).toBe(0);
		expect(harness.faux.callCount).toBe(1);
	});

	it("consumes the completed-turn stop cache at the dependency handoff", async () => {
		let stopCalls = 0;
		let completedTurn: import("@earendil-works/pi-agent-core").ShouldStopAfterTurnContext | undefined;
		const harness = await createHarnessWithExtensions({
			responses: ["finished"],
			configureAgent: (agent) => {
				agent.shouldStopAfterTurn = (context) => {
					stopCalls++;
					completedTurn = context;
					return stopCalls > 1;
				};
			},
		});
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt("finish and consume the cached stop result");

		expect(stopCalls).toBe(1);
		expect(completedTurn).toBeDefined();
		const freshResult = await harness.agent.shouldStopAfterTurn?.(completedTurn!);
		expect(freshResult).toBe(true);
		expect(stopCalls).toBe(2);
	});

	it("clears the completed-turn stop cache when preparation rejects before dependency handoff", async () => {
		let stopCalls = 0;
		let prepareCalls = 0;
		let completedTurn: import("@earendil-works/pi-agent-core").ShouldStopAfterTurnContext | undefined;
		const harness = await createHarnessWithExtensions({
			responses: [
				{ toolCalls: [{ id: "call-rejected-preparation", name: "large_result", args: {} }] },
				"later run completed",
			],
			baseToolsOverride: { large_result: largeResultTool },
			configureAgent: (agent) => {
				agent.shouldStopAfterTurn = (context) => {
					stopCalls++;
					completedTurn ??= context;
					return stopCalls > 1;
				};
				agent.prepareNextTurnWithContext = () => {
					prepareCalls++;
					throw new Error("caller preparation failed");
				};
			},
		});
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt("run the tool before preparation fails");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "caller preparation failed",
		});

		expect(stopCalls).toBe(1);
		expect(prepareCalls).toBe(1);
		expect(completedTurn).toBeDefined();
		const freshResult = await harness.agent.shouldStopAfterTurn?.(completedTurn!);
		expect(freshResult).toBe(true);
		expect(stopCalls).toBe(2);

		await harness.session.prompt("start a clean later run");
		expect(harness.faux.callCount).toBe(2);
		expect(stopCalls).toBe(3);
	});

	it("prepares a final response only when queued steering creates another turn", async () => {
		let markResponseStarted!: () => void;
		const responseStarted = new Promise<void>((resolve) => {
			markResponseStarted = resolve;
		});
		let releaseResponse!: () => void;
		const responseReleased = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});

		const order: string[] = [];
		let prepareCalls = 0;
		const harness = await createHarnessWithExtensions({
			responses: [
				{
					text: "first response",
					beforeEmit: async () => {
						markResponseStarted();
						await responseReleased;
					},
				},
				"response after steering",
			],
			configureAgent: (agent) => {
				agent.shouldStopAfterTurn = () => {
					order.push("shouldStopAfterTurn");
					return false;
				};
				agent.prepareNextTurnWithContext = () => {
					prepareCalls++;
					order.push("prepareNextTurnWithContext");
					return undefined;
				};
			},
		});
		harnesses.push(harness);
		await wireHarness(harness);

		const prompt = harness.session.prompt("finish, unless steering is queued");
		await responseStarted;
		await harness.session.steer("continue with this direction");
		releaseResponse();
		await prompt;

		expect(order).toEqual(["shouldStopAfterTurn", "prepareNextTurnWithContext", "shouldStopAfterTurn"]);
		expect(prepareCalls).toBe(1);
		expect(harness.faux.callCount).toBe(2);
		expect(JSON.stringify(harness.faux.contexts[1]?.messages)).toContain("continue with this direction");
	});

	it.each([
		["steering", "steer"],
		["follow-up", "followUp"],
	] as const)(
		"prepares %s admitted after final-turn settlement before the dependency polls its queue",
		async (_label, delivery) => {
			const order: string[] = [];
			const preparedLateSentinel = `[prepared before late ${delivery}]`;
			let prepareCalls = 0;
			const harness = await createHarnessWithExtensions({
				responses: [
					"first response",
					{ text: `response after late ${delivery}`, beforeEmit: () => order.push("provider") },
				],
				configureAgent: (agent) => {
					agent.shouldStopAfterTurn = () => {
						order.push("shouldStopAfterTurn");
						return false;
					};
					agent.prepareNextTurnWithContext = (context) => {
						prepareCalls++;
						order.push("prepareNextTurnWithContext");
						return {
							context: {
								...context.context,
								messages: [
									...context.context.messages,
									{
										role: "user",
										content: [{ type: "text", text: preparedLateSentinel }],
										timestamp: 1,
									},
								],
							},
						};
					};
				},
			});
			harnesses.push(harness);
			await wireHarness(harness);

			const installedShouldStop = harness.agent.shouldStopAfterTurn;
			let admitted = false;
			harness.agent.shouldStopAfterTurn = async (context, signal) => {
				const shouldStop = (await installedShouldStop?.(context, signal)) ?? false;
				if (!admitted) {
					admitted = true;
					order.push("lateAdmission");
					await harness.session[delivery](`late ${delivery} after final queue check`);
				}
				return shouldStop;
			};

			await harness.session.prompt(`finish, unless ${delivery} arrives after settlement`);

			expect(order).toEqual([
				"shouldStopAfterTurn",
				"lateAdmission",
				"prepareNextTurnWithContext",
				"provider",
				"shouldStopAfterTurn",
			]);
			expect(prepareCalls).toBe(1);
			expect(harness.faux.callCount).toBe(2);
			const resumedContext = JSON.stringify(harness.faux.contexts[1]?.messages);
			expect(resumedContext).toContain(preparedLateSentinel);
			expect(resumedContext).toContain(`late ${delivery} after final queue check`);
		},
	);
	it("prepares late steering after a terminating tool batch before the dependency polls its queue", async () => {
		const order: string[] = [];
		const preparedLateSentinel = "[prepared after terminating batch]";
		let prepareCalls = 0;
		const harness = await createHarnessWithExtensions({
			responses: [
				{ toolCalls: [{ id: "call-terminate-late-steer", name: "large_result", args: {} }] },
				{ text: "response after terminating batch steering", beforeEmit: () => order.push("provider") },
			],
			baseToolsOverride: { large_result: terminatingLargeResultTool },
			configureAgent: (agent) => {
				agent.shouldStopAfterTurn = () => {
					order.push("shouldStopAfterTurn");
					return false;
				};
				agent.prepareNextTurnWithContext = (context) => {
					prepareCalls++;
					order.push("prepareNextTurnWithContext");
					return {
						context: {
							...context.context,
							messages: [
								...context.context.messages,
								{
									role: "user",
									content: [{ type: "text", text: preparedLateSentinel }],
									timestamp: 1,
								},
							],
						},
					};
				};
			},
		});
		harnesses.push(harness);
		await wireHarness(harness);

		const installedShouldStop = harness.agent.shouldStopAfterTurn;
		let admitted = false;
		harness.agent.shouldStopAfterTurn = async (context, signal) => {
			const shouldStop = (await installedShouldStop?.(context, signal)) ?? false;
			if (!admitted) {
				admitted = true;
				order.push("lateAdmission");
				await harness.session.steer("continue after the terminating batch");
			}
			return shouldStop;
		};

		await harness.session.prompt("run the terminating tool");

		expect(order).toEqual([
			"shouldStopAfterTurn",
			"lateAdmission",
			"prepareNextTurnWithContext",
			"provider",
			"shouldStopAfterTurn",
		]);
		expect(prepareCalls).toBe(1);
		expect(harness.faux.callCount).toBe(2);
		const resumedContext = JSON.stringify(harness.faux.contexts[1]?.messages);
		expect(resumedContext).toContain(preparedLateSentinel);
		expect(resumedContext).toContain("continue after the terminating batch");
	});

	it.each([
		["steering", "steer"],
		["follow-up", "followUp"],
	] as const)("prepares late %s admitted during fallback settlement", async (_label, delivery) => {
		let markQueueSnapshotTaken!: () => void;
		const queueSnapshotTaken = new Promise<void>((resolve) => {
			markQueueSnapshotTaken = resolve;
		});
		let releaseSettlement!: () => void;
		const settlementReleased = new Promise<void>((resolve) => {
			releaseSettlement = resolve;
		});
		let installSettlementGate!: () => void;
		const order: string[] = [];
		let stopChecks = 0;
		let prepareCalls = 0;
		const harness = await createHarnessWithExtensions({
			responses: [
				{ text: "first response", beforeEmit: () => installSettlementGate() },
				`response after late ${delivery}`,
			],
			configureAgent: (agent) => {
				agent.shouldStopAfterTurn = () => {
					stopChecks++;
					order.push("shouldStopAfterTurn");
					return false;
				};
				agent.prepareNextTurnWithContext = () => {
					prepareCalls++;
					order.push("prepareNextTurnWithContext");
					return undefined;
				};
			},
		});
		harnesses.push(harness);
		await wireHarness(harness);
		const internal = harness.session as unknown as { _agentEventQueue: Promise<void> };
		installSettlementGate = () => {
			internal._agentEventQueue = internal._agentEventQueue.then(() => settlementReleased);
		};
		const hasQueuedMessages = harness.agent.hasQueuedMessages.bind(harness.agent);
		let snapshotMarked = false;
		harness.agent.hasQueuedMessages = () => {
			const hasQueued = hasQueuedMessages();
			if (stopChecks === 1 && !snapshotMarked) {
				snapshotMarked = true;
				markQueueSnapshotTaken();
			}
			return hasQueued;
		};

		const prompt = harness.session.prompt("finish, unless a message arrives while fallback settles");
		await queueSnapshotTaken;
		await harness.session[delivery](`late ${delivery}`);
		expect(harness.agent.hasQueuedMessages()).toBe(true);
		releaseSettlement();
		await prompt;

		expect(order).toEqual(["shouldStopAfterTurn", "prepareNextTurnWithContext", "shouldStopAfterTurn"]);
		expect(prepareCalls).toBe(1);
		expect(harness.faux.callCount).toBe(2);
		expect(JSON.stringify(harness.faux.contexts[1]?.messages)).toContain(`late ${delivery}`);
	});

	it("does not compact an all-blocked terminating batch", async () => {
		const blockTerminatingTool: ExtensionFactory = (pi) => {
			pi.on("tool_call", () => ({ block: true, reason: "blocked", terminate: true }));
		};
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-blocked-terminate", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [compactOffline, blockTerminatingTool],
		});
		harnesses.push(harness);
		await wireHarness(harness);

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("applies the hard-limit gate after context extensions transform the compacted messages", async () => {
		const expandingContext: ExtensionFactory = (pi) => {
			let compacted = false;
			pi.on("session_before_compact", () => ({ compactedText: "[User]: retained" }));
			pi.on("session_compact", () => {
				compacted = true;
			});
			pi.on("context", (event) =>
				compacted
					? {
							messages: [
								...event.messages,
								{ role: "user", content: "expanded ".repeat(2_000), timestamp: Date.now() },
							],
						}
					: undefined,
			);
		};
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-context-expand", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [expandingContext],
		});
		harnesses.push(harness);
		await wireHarness(harness);
		const guardTransform = harness.agent.transformContext;
		harness.agent.transformContext = async (messages, signal) => {
			const transformed = await harness.session.extensionRunner.emitContext(messages);
			return guardTransform ? await guardTransform(transformed, signal) : transformed;
		};

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ midTurn: true, errorMessage: expect.stringContaining("provider hard input limit") }),
		]);
	});
	it("blocks a known hard-limit overflow when one compaction attempt is insufficient", async () => {
		const oversizedCompaction: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", () => ({ compactedText: `retained ${"z ".repeat(5_000)}` }));
		};
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-hard-limit", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				"must not be requested",
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [oversizedCompaction],
		});
		harnesses.push(harness);
		await wireHarness(harness);
		const continueSpy = vi.spyOn(harness.agent, "continue");

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("model_fallback_start")).toHaveLength(0);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "threshold",
				aborted: false,
				willRetry: false,
				errorMessage: expect.stringContaining("provider hard input limit"),
			}),
		]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("next provider request was not sent"),
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("honors an explicit abort while the post-tool compaction hook is active", async () => {
		let signalHookStarted: (() => void) | undefined;
		const hookStarted = new Promise<void>((resolve) => {
			signalHookStarted = resolve;
		});
		const abortableCompaction: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", async (event) => {
				signalHookStarted?.();
				await new Promise<void>((resolve) =>
					event.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				return { cancel: true };
			});
		};
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-abort", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
			],
			baseToolsOverride: { large_result: largeResultTool },
			extensionFactories: [abortableCompaction],
		});
		harnesses.push(harness);
		await wireHarness(harness);

		const prompt = harness.session.prompt(longPrompt);
		await hookStarted;
		expect(harness.session.isCompacting).toBe(true);
		harness.session.abortCompaction();
		await prompt;

		expect(harness.faux.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: true, willRetry: false }),
		]);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
