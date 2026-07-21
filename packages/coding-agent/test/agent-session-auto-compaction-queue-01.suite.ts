import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";
import { appendTestCompaction } from "./verbatim-compaction-test-helpers.ts";


const compactionMocks = vi.hoisted(() => ({
	runVerbatimCompaction: vi.fn(async (..._args: unknown[]) => ({
		text: "[User]: retained test context\n(filtered 1 lines)",
		ranges: [{ start: 2, end: 2 }],
		stats: { linesBefore: 2, linesDeleted: 1, linesKept: 1, rangeCount: 1, tokensBefore: 100, tokensAfter: 50, percentReduction: 50 },
		rung: "planned" as const,
	})),
}));

vi.mock("../src/core/compaction/index.js", () => ({
	VERBATIM_COMPACTION_PROMPT_VERSION: 3,
	VERBATIM_COMPACTION_STRATEGY: "verbatim-lines",
	calculateContextTokens: (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
	}) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	runVerbatimCompaction: compactionMocks.runVerbatimCompaction,
	estimateContextTokens: (
		messages: Array<{
			role: string;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
			stopReason?: string;
		}>,
	) => {
		// Walk backwards to find last non-error, non-aborted assistant with usage
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted" && msg.usage) {
				const tokens =
					msg.usage.totalTokens ?? msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				return { tokens, usageTokens: tokens, trailingTokens: 0, lastUsageIndex: i };
			}
		}
		return { tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null };
	},
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompactionBoundary: (entries: Array<{ id: string }>) => entries[0] ? ({
		firstKeptEntryId: entries[0].id,
		region: { __brand: "NumberedRegion", lines: ["[User]: test", "body"], headerLineNumbers: new Set([1]), priorMarkerNs: new Map(), tokenEstimate: 10 },
		regionEntryIds: [entries[0].id], keptTailMessageCount: 1, tokensBefore: 100,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
		settings: { enabled: true, reserveTokens: 16384, compression_ratio: 0.5, preserve_recent: 2 },
	}) : undefined,
	shouldCompact: (
		contextTokens: number,
		contextWindow: number,
		settings: { enabled: boolean; reserveTokens: number },
	) => settings.enabled && contextTokens > contextWindow - settings.reserveTokens,
}));
describe("AgentSession auto-compaction queue resume", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(() => {
		compactionMocks.runVerbatimCompaction.mockClear();
		tempDir = join(tmpdir(), `pi-auto-compaction-queue-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "existing compactable context" }], timestamp: Date.now() });
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
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("passes the current thinking level to auto context compaction", async () => {
		session.agent.state.thinkingLevel = "high";
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", false);

		expect(compactionMocks.runVerbatimCompaction).toHaveBeenCalledTimes(1);
		expect(compactionMocks.runVerbatimCompaction.mock.calls[0]?.[5]).toBe("high");
	});
	it("passes active model and stream identity to one-pass context compaction", async () => {
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", false);
		expect(compactionMocks.runVerbatimCompaction.mock.calls[0]?.[1]).toBe(session.model);
		expect(compactionMocks.runVerbatimCompaction.mock.calls[0]?.[6]).toMatchObject({ streamFn: session.agent.streamFunction });

		compactionMocks.runVerbatimCompaction.mockClear();
		await runAutoCompaction("overflow", false);
		expect(compactionMocks.runVerbatimCompaction.mock.calls[0]?.[6]).toMatchObject({ streamFn: session.agent.streamFunction });
	});
	it.each(["threshold", "overflow"] as const)("does not persist or schedule continuation when %s planning fails", async (reason) => {
		compactionMocks.runVerbatimCompaction.mockRejectedValueOnce(new Error("malformed planner response"));
		const events: Array<{ type: string; willRetry?: boolean; errorMessage?: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") events.push(event);
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (candidate: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction(reason, true);
		await vi.advanceTimersByTimeAsync(100);

		expect(compactionMocks.runVerbatimCompaction).toHaveBeenCalledTimes(1);
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(events.at(-1)).toMatchObject({ type: "compaction_end", willRetry: false, errorMessage: expect.stringContaining("malformed planner response") });
	});
	it("should resume after threshold compaction when only agent-level queued messages exist", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const drainSpy = vi.spyOn(session as unknown as { _continueQueuedAgentMessages: () => Promise<void> }, "_continueQueuedAgentMessages").mockResolvedValue();

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(drainSpy).toHaveBeenCalledTimes(1);
	});
	it("should resume when compaction_end listener asynchronously queues work before the deferred probe", async () => {
		let queuedAtCompactionEnd: boolean | undefined;
		session.subscribe((event) => {
			if (event.type !== "compaction_end" || event.reason !== "threshold") {
				return;
			}
			queuedAtCompactionEnd = session.agent.hasQueuedMessages();
			setTimeout(() => {
				session.agent.followUp({
					role: "custom",
					customType: "test",
					content: [{ type: "text", text: "Queued after compaction_end" }],
					display: false,
					timestamp: Date.now(),
				});
			}, 0);
		});

		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(false);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const drainSpy = vi.spyOn(session as unknown as { _continueQueuedAgentMessages: () => Promise<void> }, "_continueQueuedAgentMessages").mockResolvedValue();

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", false);

		expect(queuedAtCompactionEnd).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(false);

		await vi.advanceTimersByTimeAsync(0);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(drainSpy).toHaveBeenCalledTimes(1);
	});
	it("should suppress deferred continuation when streaming starts before the probe", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", false);

		const isStreamingSpy = vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
		await vi.advanceTimersByTimeAsync(100);
		isStreamingSpy.mockRestore();

		expect(continueSpy).not.toHaveBeenCalled();
	});
	it("should clean overflow retry context before compaction_end even when streaming starts before the deferred probe", async () => {
		const model = session.model!;
		const trailingOverflowError: AssistantMessage = {
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
		const rebuiltMessages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "retry this" }], timestamp: Date.now() - 1 },
			trailingOverflowError,
		];
		vi.spyOn(sessionManager, "buildSessionContext").mockReturnValue({
			messages: rebuiltMessages,
			thinkingLevel: "off",
			model: null,
		});

		let streamingStarted = false;
		const isStreamingSpy = vi.spyOn(session, "isStreaming", "get").mockImplementation(() => streamingStarted);
		let listenerObservedLastMessage: AgentMessage | undefined;
		session.subscribe((event) => {
			if (event.type !== "compaction_end" || event.reason !== "overflow") {
				return;
			}
			listenerObservedLastMessage = session.agent.state.messages.at(-1);
			streamingStarted = true;
		});

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("overflow", true);

		expect(listenerObservedLastMessage).toMatchObject({ role: "user" });
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "user" });

		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).not.toHaveBeenCalled();
		isStreamingSpy.mockRestore();
	});
	it("should not resume after threshold compaction when no agent-level queued messages exist", async () => {
		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(false);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(500);

		expect(continueSpy).not.toHaveBeenCalled();
	});
	it("should not compact repeatedly after overflow recovery already attempted", async () => {
		const model = session.model!;
		const overflowMessage: AssistantMessage = {
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

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const events: Array<{ type: string; reason: string; errorMessage?: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				events.push({ type: event.type, reason: event.reason, errorMessage: event.errorMessage });
			}
		});

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(overflowMessage);
		await checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({
			type: "compaction_end",
			reason: "overflow",
			errorMessage:
				"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		});
	});
	it("should ignore stale pre-compaction assistant usage on pre-prompt compaction checks", async () => {
		const model = session.model!;
		const staleAssistantTimestamp = Date.now() - 10_000;
		const staleAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large response before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 600_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 610_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: staleAssistantTimestamp,
		};

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleAssistantTimestamp - 1000,
		});
		sessionManager.appendMessage(staleAssistant);
		appendTestCompaction(sessionManager, staleAssistant.usage.totalTokens, 50_000);

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "session recovery payload" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});
	it("should ignore stale pre-context-compaction assistant usage on pre-prompt compaction checks", async () => {
		const model = session.model!;
		const staleAssistantTimestamp = Date.now() - 10_000;
		const staleAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large response before context compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 600_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 610_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: staleAssistantTimestamp,
		};

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before context compaction" }],
			timestamp: staleAssistantTimestamp - 1000,
		});
		sessionManager.appendMessage(staleAssistant);
		appendTestCompaction(sessionManager, 610_000, 50_000);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "session recovery payload" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});
});
