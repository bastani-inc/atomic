import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	MAX_LENGTH_CONTINUATION_ATTEMPTS,
	MAX_OUTPUT_BUDGET_ERROR_CONTINUATION_ATTEMPTS,
} from "../src/core/agent-session-auto-compaction.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createContextCompactionStats(tokensBefore: number, tokensAfter: number) {
	return {
		objectsBefore: 1,
		objectsAfter: 1,
		objectsDeleted: 0,
		tokensBefore,
		tokensAfter,
		percentReduction: tokensBefore === 0 ? 0 : ((tokensBefore - tokensAfter) / tokensBefore) * 100,
	};
}

const compactionMocks = vi.hoisted(() => ({
	contextCompact: vi.fn(async (..._args: unknown[]) => ({
		deletedTargets: [],
		protectedEntryIds: [],
		stats: createContextCompactionStats(190_000, 120_000),
	})),
	estimateContextTokens: vi.fn(() => ({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null })),
}));

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number }) =>
		usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, details: {} }),
	contextCompact: compactionMocks.contextCompact,
	estimateContextTokens: compactionMocks.estimateContextTokens,
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareContextCompaction: () => ({ dummy: true }),
	shouldCompact: (contextTokens: number, contextWindow: number, settings: { enabled: boolean; reserveTokens: number }) =>
		settings.enabled && contextTokens > contextWindow - settings.reserveTokens,
}));

describe("AgentSession auto-compaction length-stop resume", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(() => {
		compactionMocks.contextCompact.mockClear();
		compactionMocks.estimateContextTokens.mockReset();
		compactionMocks.estimateContextTokens.mockReturnValue({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null });
		tempDir = join(tmpdir(), `pi-auto-compaction-length-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });
		sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function lengthStoppedAssistant(): AssistantMessage {
		const model = session.model!;
		return {
			role: "assistant",
			content: [{ type: "text", text: "partial response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 180_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 190_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	function belowThresholdLengthStoppedAssistant(): AssistantMessage {
		const assistant = lengthStoppedAssistant();
		// Keep the context well below the compaction budget so compaction is a
		// no-op and only the direct length continuation can fire.
		assistant.usage = {
			...assistant.usage,
			input: 40_000,
			output: 10_000,
			totalTokens: 50_000,
		};
		return assistant;
	}

	function previousHighUsageAssistant(): AssistantMessage {
		const model = session.model!;
		return {
			role: "assistant",
			content: [{ type: "text", text: "previous complete response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 180_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 190_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 500,
		};
	}

	function outputBudgetErrorAssistant(
		errorMessage?: string,
		api: AssistantMessage["api"] = "openai-responses",
	): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api,
			provider: "github-copilot",
			model: "gpt-5.5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: Date.now(),
			errorMessage:
				errorMessage ??
				`OpenAI API error (400): {"message":"Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.","code":"invalid_request_body"}`,
		};
	}

	it("compacts and retries threshold-sized length-stopped responses", async () => {
		const assistant = lengthStoppedAssistant();
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			assistant,
		];
		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }, "_runAutoCompaction")
			.mockResolvedValue();
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", true);
	});

	it("does not retry zero-output length stops through threshold compaction", async () => {
		const assistant = lengthStoppedAssistant();
		assistant.usage = {
			...assistant.usage,
			input: 190_000,
			output: 0,
			totalTokens: 190_000,
		};
		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }, "_runAutoCompaction")
			.mockResolvedValue();
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("compacts and retries the reported OpenAI Responses output-budget underflow shape", async () => {
		const previousAssistant = previousHighUsageAssistant();
		const assistant = outputBudgetErrorAssistant();
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "continue the task" }], timestamp: Date.now() - 1000 },
			previousAssistant,
			assistant,
		];
		compactionMocks.estimateContextTokens.mockReturnValue({
			tokens: 190_000,
			usageTokens: 190_000,
			trailingTokens: 0,
			lastUsageIndex: 1,
		});
		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }, "_runAutoCompaction")
			.mockResolvedValue();
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", true);
	});

	it("stops retrying consecutive output-budget underflows after a compact-and-retry attempt", async () => {
		const previousAssistant = previousHighUsageAssistant();
		const assistant = outputBudgetErrorAssistant();
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "continue the task" }], timestamp: Date.now() - 1000 },
			previousAssistant,
			assistant,
		];
		compactionMocks.estimateContextTokens.mockReturnValue({
			tokens: 190_000,
			usageTokens: 190_000,
			trailingTokens: 0,
			lastUsageIndex: 1,
		});
		(session as unknown as { _outputBudgetErrorContinuationAttempts: number })._outputBudgetErrorContinuationAttempts =
			MAX_OUTPUT_BUDGET_ERROR_CONTINUATION_ATTEMPTS;
		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }, "_runAutoCompaction")
			.mockResolvedValue();
		const emitted: Array<{ type: string; reason?: string; willRetry?: boolean; errorMessage?: string }> = [];
		vi.spyOn(session as unknown as { _emit: (event: { type: string; reason?: string; willRetry?: boolean; errorMessage?: string }) => void }, "_emit").mockImplementation((event) => {
			emitted.push(event);
		});
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "compaction_end",
				reason: "threshold",
				willRetry: false,
				errorMessage: expect.stringContaining("Output-budget recovery stopped"),
			}),
		);
	});

	it("compacts and retries structured OpenAI Responses output-budget underflow errors", async () => {
		const previousAssistant = previousHighUsageAssistant();
		const assistant = outputBudgetErrorAssistant(
			`OpenAI API error (400): {"error":{"message":"Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.","param":"max_output_tokens","code":"invalid_request_error"}}`,
		);
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "continue the task" }], timestamp: Date.now() - 1000 },
			previousAssistant,
			assistant,
		];
		compactionMocks.estimateContextTokens.mockReturnValue({
			tokens: 190_000,
			usageTokens: 190_000,
			trailingTokens: 0,
			lastUsageIndex: 1,
		});
		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }, "_runAutoCompaction")
			.mockResolvedValue();
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", true);
	});

	it("does not retry non-Responses output-budget-like errors", async () => {
		const previousAssistant = previousHighUsageAssistant();
		const assistant = outputBudgetErrorAssistant(undefined, "openai-completions");
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "continue the task" }], timestamp: Date.now() - 1000 },
			previousAssistant,
			assistant,
		];
		compactionMocks.estimateContextTokens.mockReturnValue({
			tokens: 190_000,
			usageTokens: 190_000,
			trailingTokens: 0,
			lastUsageIndex: 1,
		});
		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }, "_runAutoCompaction")
			.mockResolvedValue();
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not retry generic invalid request errors after threshold compaction", async () => {
		const previousAssistant = previousHighUsageAssistant();
		const assistant = outputBudgetErrorAssistant(
			`OpenAI API error (400): {"message":"Invalid schema for function 'bash': invalid request body","code":"invalid_request_body"}`,
		);
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "continue the task" }], timestamp: Date.now() - 1000 },
			previousAssistant,
			assistant,
		];
		compactionMocks.estimateContextTokens.mockReturnValue({
			tokens: 190_000,
			usageTokens: 190_000,
			trailingTokens: 0,
			lastUsageIndex: 1,
		});
		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }, "_runAutoCompaction")
			.mockResolvedValue();
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("auto-continues after threshold compaction of an output-budget error", async () => {
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "finish the task" }],
			timestamp: Date.now() - 1000,
		};
		const assistant = outputBudgetErrorAssistant();
		sessionManager.appendMessage(userMessage);
		sessionManager.appendMessage(assistant);
		session.agent.state.messages = [userMessage, assistant];
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			expect(session.agent.state.messages.at(-1)?.role).toBe("user");
		});
		const waitSpy = vi.spyOn(session, "waitForRetry").mockResolvedValue();
		const drainSpy = vi
			.spyOn(session as unknown as { _continueQueuedAgentMessages: () => Promise<void> }, "_continueQueuedAgentMessages")
			.mockResolvedValue();
		const runAutoCompaction = (
			session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", true);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(waitSpy).toHaveBeenCalledTimes(1);
		expect(drainSpy).toHaveBeenCalledTimes(1);
	});

	it("auto-continues after threshold compaction of a length-stopped response", async () => {
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "write a long answer" }],
			timestamp: Date.now() - 1000,
		};
		const assistant = lengthStoppedAssistant();
		sessionManager.appendMessage(userMessage);
		sessionManager.appendMessage(assistant);
		session.agent.state.messages = [userMessage, assistant];
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			expect(session.agent.state.messages.at(-1)?.role).toBe("user");
		});
		const waitSpy = vi.spyOn(session, "waitForRetry").mockResolvedValue();
		const drainSpy = vi
			.spyOn(session as unknown as { _continueQueuedAgentMessages: () => Promise<void> }, "_continueQueuedAgentMessages")
			.mockResolvedValue();
		const runAutoCompaction = (
			session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", true);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(waitSpy).toHaveBeenCalledTimes(1);
		expect(drainSpy).toHaveBeenCalledTimes(1);
	});

	it("continues a below-threshold length-stopped response without compacting", async () => {
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "write a long answer" }],
			timestamp: Date.now() - 1000,
		};
		const assistant = belowThresholdLengthStoppedAssistant();
		sessionManager.appendMessage(userMessage);
		sessionManager.appendMessage(assistant);
		session.agent.state.messages = [userMessage, assistant];
		const runAutoCompactionSpy = vi
			.spyOn(session as unknown as { _runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void> }, "_runAutoCompaction")
			.mockResolvedValue();
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			// The incomplete length-stopped assistant is dropped so the anchor is a user message.
			expect(session.agent.state.messages.at(-1)?.role).toBe("user");
		});
		vi.spyOn(session, "waitForRetry").mockResolvedValue();
		vi.spyOn(session as unknown as { _continueQueuedAgentMessages: () => Promise<void> }, "_continueQueuedAgentMessages").mockResolvedValue();
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);
		await vi.advanceTimersByTimeAsync(100);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("does not continue a below-threshold zero-output length stop", async () => {
		const assistant = belowThresholdLengthStoppedAssistant();
		assistant.usage = { ...assistant.usage, output: 0, totalTokens: 40_000 };
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			assistant,
		];
		const resumeSpy = vi.spyOn(
			session as unknown as { _resumeAfterLengthTruncation: () => void },
			"_resumeAfterLengthTruncation",
		);
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);

		expect(resumeSpy).not.toHaveBeenCalled();
	});

	it("does not resume a length truncation before a fresh user prompt (non-live path)", async () => {
		const assistant = belowThresholdLengthStoppedAssistant();
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			assistant,
		];
		const resumeSpy = vi.spyOn(
			session as unknown as { _resumeAfterLengthTruncation: () => void },
			"_resumeAfterLengthTruncation",
		);
		const checkCompaction = (
			session as unknown as { _checkCompaction: (message: AssistantMessage, skipAbortedCheck: boolean) => Promise<void> }
		)._checkCompaction.bind(session);

		// skipAbortedCheck=false marks the pre-prompt path; a new user turn must not resume the old one.
		await checkCompaction(assistant, false);

		expect(resumeSpy).not.toHaveBeenCalled();
	});

	it("stops continuing after MAX_LENGTH_CONTINUATION_ATTEMPTS", async () => {
		const assistant = belowThresholdLengthStoppedAssistant();
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			assistant,
		];
		(session as unknown as { _lengthContinuationAttempts: number })._lengthContinuationAttempts = MAX_LENGTH_CONTINUATION_ATTEMPTS;
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session, "waitForRetry").mockResolvedValue();
		const checkCompaction = (session as unknown as { _checkCompaction: (message: AssistantMessage) => Promise<void> })._checkCompaction.bind(session);

		await checkCompaction(assistant);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).not.toHaveBeenCalled();
	});
});
