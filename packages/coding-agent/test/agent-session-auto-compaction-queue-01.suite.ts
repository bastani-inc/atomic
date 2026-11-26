import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@bastani/atomic-agent-core";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AutoCompactionRunOutcome } from "../src/core/agent-session-methods.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createFauxStreamFn } from "./test-harness.ts";
import { createTestResourceLoader } from "./utilities.ts";
import { appendTestCompaction } from "./verbatim-compaction-test-helpers.ts";

vi.mock("../src/core/compaction/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/compaction/index.js")>()),
	calculateContextTokens: (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
	}) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
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

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-auto-compaction-queue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();
		const model = getFixtureModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: createFauxStreamFn(["Queued response"]).streamFn,
		});
		sessionManager = SessionManager.inMemory();
		await sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "existing compactable context" }],
			timestamp: Date.now(),
		});
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
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
		const drainSpy = vi
			.spyOn(
				session as unknown as { _continueQueuedAgentMessages: () => Promise<void> },
				"_continueQueuedAgentMessages",
			)
			.mockResolvedValue();

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
		const drainSpy = vi
			.spyOn(
				session as unknown as { _continueQueuedAgentMessages: () => Promise<void> },
				"_continueQueuedAgentMessages",
			)
			.mockResolvedValue();

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
	it("waits for active work to settle before dequeuing a message queued before compaction", async () => {
		await session.followUp("Queued before compaction");
		expect(session.pendingMessageCount).toBe(1);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		let releaseIdle: () => void = () => {};
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const waitForIdleSpy = vi.spyOn(session.agent, "waitForIdle").mockReturnValue(idle);
		const isStreamingSpy = vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
		const clearQueueSpy = vi.spyOn(session, "clearQueue");
		const internals = session as unknown as {
			_runAutoCompaction: (
				reason: "overflow" | "threshold",
				willRetry: boolean,
				urgency: "load_bearing" | "recoverable",
			) => Promise<void>;
			_awaitPendingPostCompactionContinuation: () => Promise<void>;
		};

		await internals._runAutoCompaction("threshold", false, "recoverable");
		await vi.advanceTimersByTimeAsync(100);
		expect(session.pendingMessageCount).toBe(1);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		isStreamingSpy.mockRestore();
		releaseIdle();
		await internals._awaitPendingPostCompactionContinuation();
		expect(waitForIdleSpy).toHaveBeenCalledTimes(1);
		expect(clearQueueSpy).not.toHaveBeenCalled();
		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(false);
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
		// The overflow attempt is persisted like any finalized assistant; recovery must
		// omit it from the canonical projection before compaction_end listeners observe state.
		await sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "retry this" }],
			timestamp: Date.now() - 1,
		});
		await sessionManager.appendMessage(trailingOverflowError);
		session.refreshContext();
		expect(session.agent.state.messages.at(-1)).toBe(trailingOverflowError);

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

		expect(listenerObservedLastMessage?.role).not.toBe("assistant");
		expect(session.agent.state.messages.at(-1)?.role).not.toBe("assistant");
		expect(session.agent.state.messages).toEqual(sessionManager.buildSessionProjection().messages);
		expect(session.agent.state.messages).not.toContain(trailingOverflowError);

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
					_runAutoCompaction: (
						reason: "overflow" | "threshold",
						willRetry: boolean,
						urgency?: "load_bearing" | "recoverable",
					) => Promise<AutoCompactionRunOutcome>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue("compacted");

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

		await sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleAssistantTimestamp - 1000,
		});
		await sessionManager.appendMessage(staleAssistant);
		await appendTestCompaction(sessionManager, staleAssistant.usage.totalTokens, 50_000);

		await sessionManager.appendMessage({
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

		await sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before context compaction" }],
			timestamp: staleAssistantTimestamp - 1000,
		});
		await sessionManager.appendMessage(staleAssistant);
		await appendTestCompaction(sessionManager, 610_000, 50_000);
		await sessionManager.appendMessage({
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
