import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { MAX_OUTPUT_BUDGET_ERROR_CONTINUATION_ATTEMPTS } from "../../src/core/agent-session-auto-compaction.ts";
import type { VerbatimCompactionResult } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession compact API typing", () => {
	it("returns the verbatim result shape", () => {
		type Result = Awaited<ReturnType<AgentSession["compact"]>>;
		const accept = (result: Result): VerbatimCompactionResult => result;
		expect(typeof accept).toBe("function");
	});
});

type CompactFailedEvent = {
	type: "session_compact_failed";
	reason: "manual" | "threshold" | "overflow";
	errorMessage?: string;
	aborted: boolean;
	willRetry: boolean;
	fromExtension: boolean;
};

function captureCompactFailedEvents(): {
	events: CompactFailedEvent[];
	extensionFactories: Array<(pi: { on: AgentSession["on"] }) => void>;
} {
	const events: CompactFailedEvent[] = [];
	return {
		events,
		extensionFactories: [
			(pi) => {
				pi.on("session_compact_failed", (event) => events.push(event));
			},
		],
	};
}

describe("session_compact_failed", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		vi.restoreAllMocks();
		harness?.cleanup();
	});

	it("notifies extensions when automatic Verbatim Compaction fails", async () => {
		const failed = captureCompactFailedEvents();
		harness = await createHarness({ extensionFactories: failed.extensionFactories });
		const internals = harness.session as unknown as {
			_applyVerbatimCompaction(): Promise<VerbatimCompactionResult | undefined>;
			_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<string>;
		};
		vi.spyOn(internals, "_applyVerbatimCompaction").mockRejectedValue(new Error("planner failed"));

		await expect(internals._runAutoCompaction("threshold", false)).resolves.toBe("failed");

		expect(failed.events).toEqual([
			{
				type: "session_compact_failed",
				reason: "threshold",
				errorMessage: "Auto-compaction failed: planner failed",
				aborted: false,
				willRetry: false,
				fromExtension: false,
			},
		]);
	});

	it("notifies extensions when overflow recovery is exhausted", async () => {
		const failed = captureCompactFailedEvents();
		harness = await createHarness({ extensionFactories: failed.extensionFactories });
		const model = harness.getModel();
		const overflow: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		};
		harness.session.agent.state.messages = [overflow];
		const internals = harness.session as unknown as {
			_checkCompaction(message: AssistantMessage): Promise<void>;
			_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<"compacted">;
		};
		vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue("compacted");

		await internals._checkCompaction(overflow);
		await internals._checkCompaction({ ...overflow, timestamp: overflow.timestamp + 1 });

		expect(failed.events).toEqual([
			{
				type: "session_compact_failed",
				reason: "overflow",
				errorMessage:
					"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				aborted: false,
				willRetry: false,
				fromExtension: false,
			},
		]);
	});

	it("notifies extensions when output-budget recovery is exhausted", async () => {
		const failed = captureCompactFailedEvents();
		harness = await createHarness({
			extensionFactories: failed.extensionFactories,
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 20 }],
			settings: { compaction: { enabled: true, reserveTokens: 10 } },
		});
		const model = harness.getModel();
		const previous: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "previous response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 90,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 95,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1,
		};
		const outputBudgetError: AssistantMessage = {
			...previous,
			content: [],
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: `OpenAI API error (400): {"message":"Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.","code":"invalid_request_body"}`,
			timestamp: Date.now(),
		};
		harness.session.agent.state.messages = [previous, outputBudgetError];
		const internals = harness.session as unknown as {
			_checkCompaction(message: AssistantMessage): Promise<void>;
			_outputBudgetErrorContinuationAttempts: number;
		};
		internals._outputBudgetErrorContinuationAttempts = MAX_OUTPUT_BUDGET_ERROR_CONTINUATION_ATTEMPTS;

		await internals._checkCompaction(outputBudgetError);

		expect(failed.events).toEqual([
			{
				type: "session_compact_failed",
				reason: "threshold",
				errorMessage:
					"Output-budget recovery stopped after a compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				aborted: false,
				willRetry: false,
				fromExtension: false,
			},
		]);
	});

	it("notifies extensions without error text when post-tool compaction is aborted", async () => {
		const failed = captureCompactFailedEvents();
		harness = await createHarness({
			extensionFactories: failed.extensionFactories,
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 20 }],
			settings: { compaction: { enabled: true, reserveTokens: 10 } },
		});
		const internals = harness.session as unknown as {
			_applyVerbatimCompaction(): Promise<VerbatimCompactionResult | undefined>;
		};
		vi.spyOn(internals, "_applyVerbatimCompaction").mockRejectedValue(new Error("planner interrupted"));
		const controller = new AbortController();
		controller.abort();

		await expect(
			harness.session._preflightPostToolContext(
				[{ role: "user", content: "x".repeat(500), timestamp: Date.now() }],
				controller.signal,
			),
		).rejects.toThrow("Post-tool context compaction was cancelled before the next provider request.");

		expect(failed.events).toEqual([
			{
				type: "session_compact_failed",
				reason: "threshold",
				aborted: true,
				willRetry: false,
				fromExtension: false,
			},
		]);
	});

	it("reports extension-provided text as the post-tool compaction source when persistence fails", async () => {
		const failed = captureCompactFailedEvents();
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ compactedText: "[User]: retained" }));
				},
				...failed.extensionFactories,
			],
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 20 }],
			settings: { compaction: { enabled: true, reserveTokens: 10, preserve_recent: 2 } },
		});
		for (let index = 0; index < 10; index++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: `transcript ${index} ${"x".repeat(100)}`,
				timestamp: Date.now() + index,
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		vi.spyOn(harness.sessionManager, "writeBackupSnapshot").mockImplementation(() => {
			throw new Error("backup failed");
		});

		await expect(
			harness.session._preflightPostToolContext([
				{ role: "user", content: "x".repeat(500), timestamp: Date.now() + 100 },
			]),
		).rejects.toThrow("Post-tool context compaction failed before the next provider request: backup failed");

		expect(failed.events).toEqual([
			{
				type: "session_compact_failed",
				reason: "threshold",
				errorMessage: "Post-tool context compaction failed before the next provider request: backup failed",
				aborted: false,
				willRetry: false,
				fromExtension: true,
			},
		]);
	});
});
