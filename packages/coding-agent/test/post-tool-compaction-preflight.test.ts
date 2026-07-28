import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { RANGE_PLANNER_SYSTEM_PROMPT } from "../src/core/compaction/range-planner.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { createHarnessWithExtensions, fauxModel, type Harness } from "./test-harness.ts";

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


	it("recovers an empty post-tool length plan at minimal reasoning before the next provider response", async () => {
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			model: { ...fauxModel, reasoning: true },
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-planner-recovery", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				{ text: "", stopReason: "length" },
				"2,20\n",
				"completed after recovered planning",
			],
			baseToolsOverride: { large_result: largeResultTool },
		});
		harnesses.push(harness);
		await wireHarness(harness);
		harness.agent.state.thinkingLevel = "max";
		const plannerRequests: SimpleStreamOptions[] = [];
		const streamFunction = harness.agent.streamFunction;
		harness.agent.streamFunction = (candidate, context, options) => {
			if (context.systemPrompt === RANGE_PLANNER_SYSTEM_PROMPT) plannerRequests.push(options ?? {});
			return streamFunction(candidate, context, options);
		};
		const continueSpy = vi.spyOn(harness.agent, "continue");

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(4);
		expect(plannerRequests.map((request) => request.reasoning)).toEqual(["low", "minimal"]);
		expect(harness.faux.contexts.filter((context) => context.systemPrompt === RANGE_PLANNER_SYSTEM_PROMPT)).toHaveLength(2);
		expect(harness.faux.contexts.filter((context) => context.systemPrompt !== RANGE_PLANNER_SYSTEM_PROMPT)).toHaveLength(2);
		expect(harness.eventsOfType("compaction_start")).toEqual([
			expect.objectContaining({ reason: "threshold", midTurn: true }),
		]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: false, willRetry: false, midTurn: true }),
		]);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("model_fallback_start")).toHaveLength(0);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.session.getLastAssistantText()).toBe("completed after recovered planning");
	});

	it("stops after two empty post-tool length plans without an ordinary follow-up request", async () => {
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			model: { ...fauxModel, reasoning: true },
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
			responses: [
				{
					toolCalls: [{ id: "call-planner-exhaustion", name: "large_result", args: {} }],
					usage: { input: 700, output: 20, totalTokens: 720 },
				},
				{ text: "", stopReason: "length" },
				{ text: "", stopReason: "length" },
				"must not be requested",
			],
			baseToolsOverride: { large_result: largeResultTool },
		});
		harnesses.push(harness);
		await wireHarness(harness);
		harness.agent.state.thinkingLevel = "high";
		const plannerRequests: SimpleStreamOptions[] = [];
		const streamFunction = harness.agent.streamFunction;
		harness.agent.streamFunction = (candidate, context, options) => {
			if (context.systemPrompt === RANGE_PLANNER_SYSTEM_PROMPT) plannerRequests.push(options ?? {});
			return streamFunction(candidate, context, options);
		};
		const continueSpy = vi.spyOn(harness.agent, "continue");

		await harness.session.prompt(longPrompt);

		expect(harness.faux.callCount).toBe(3);
		expect(plannerRequests.map((request) => request.reasoning)).toEqual(["low", "minimal"]);
		expect(harness.faux.contexts.filter((context) => context.systemPrompt === RANGE_PLANNER_SYSTEM_PROMPT)).toHaveLength(2);
		expect(harness.faux.contexts.filter((context) => context.systemPrompt !== RANGE_PLANNER_SYSTEM_PROMPT)).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("model_fallback_start")).toHaveLength(0);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "threshold",
				aborted: false,
				willRetry: false,
				errorMessage: expect.stringContaining("malformed output"),
			}),
		]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "Post-tool context compaction failed before the next provider request: Compaction range planning returned malformed output",
		});
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
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
			extension: ((pi) => pi.on("session_before_compact", () => ({ compactedText: "  \n" }))) satisfies ExtensionFactory,
			aborted: false,
			error: "No compacted text provided",
		},
	])("surfaces post-tool compaction $name without sending the follow-up request", async ({ extension, aborted, error }) => {
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
	});

	it("does not route a retryable preflight failure into retry, fallback, or continuation", async () => {
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
			responses: [{
				toolCalls: [{ id: "call-retryable-failure", name: "large_result", args: {} }],
				usage: { input: 700, output: 20, totalTokens: 720 },
			}],
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
			responses: [{
				toolCalls: [{ id: "call-terminate", name: "large_result", args: {} }],
				usage: { input: 700, output: 20, totalTokens: 720 },
			}],
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

	it("applies the hard-limit gate after context extensions transform the compacted messages", async () => {
		const expandingContext: ExtensionFactory = (pi) => {
			let compacted = false;
			pi.on("session_before_compact", () => ({ compactedText: "[User]: retained" }));
			pi.on("session_compact", () => { compacted = true; });
			pi.on("context", (event) => compacted
				? { messages: [...event.messages, { role: "user", content: "expanded ".repeat(2_000), timestamp: Date.now() }] }
				: undefined);
		};
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [{
				toolCalls: [{ id: "call-context-expand", name: "large_result", args: {} }],
				usage: { input: 700, output: 20, totalTokens: 720 },
			}],
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
		const hookStarted = new Promise<void>((resolve) => { signalHookStarted = resolve; });
		const abortableCompaction: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", async (event) => {
				signalHookStarted?.();
				await new Promise<void>((resolve) => event.signal.addEventListener("abort", () => resolve(), { once: true }));
				return { cancel: true };
			});
		};
		const harness = await createHarnessWithExtensions({
			contextWindow: 1_000,
			settings: {
				compaction: { enabled: true, reserveTokens: 200, compression_ratio: 0.5, preserve_recent: 2 },
			},
			responses: [{
				toolCalls: [{ id: "call-abort", name: "large_result", args: {} }],
				usage: { input: 700, output: 20, totalTokens: 720 },
			}],
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
