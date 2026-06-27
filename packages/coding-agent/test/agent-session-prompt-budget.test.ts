/**
 * Tests for the prompt airlock: a single user message whose estimated tokens
 * exceed the model's liveness budget is refused at submission with
 * PromptExceedsBudgetError, before it enters agent state or the streaming
 * message queue.
 *
 * See specs/2026-06-27-context-compaction-graduated-protection.md §5.4.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type TextContent,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { PromptExceedsBudgetError } from "../src/core/prompt-budget.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

// ---------------------------------------------------------------------------
// Helpers for streaming-session tests
// ---------------------------------------------------------------------------

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface PendingAgentMessageQueueForTest {
	hasItems(): boolean;
	drain(): AgentMessage[];
}

interface AgentQueueAccessForTest {
	readonly steeringQueue?: PendingAgentMessageQueueForTest;
	readonly followUpQueue?: PendingAgentMessageQueueForTest;
}

function textFromAgentMessage(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is TextContent => typeof part === "object" && part !== null && part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function drainQueuedTexts(agent: Agent): { steering: string[]; followUp: string[] } {
	const agentWithQueues = agent as unknown as AgentQueueAccessForTest;
	const drain = (queue: PendingAgentMessageQueueForTest | undefined): string[] => {
		const texts: string[] = [];
		while (queue?.hasItems()) {
			texts.push(...queue.drain().map(textFromAgentMessage));
		}
		return texts;
	};
	return {
		steering: drain(agentWithQueues.steeringQueue),
		followUp: drain(agentWithQueues.followUpQueue),
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// ===========================================================================
// Non-streaming prompt airlock
// ===========================================================================

describe("AgentSession prompt airlock — oversized input refusal", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-prompt-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) session.dispose();
		session = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(contextWindow: number, reserveTokens: number): AgentSession {
		const baseModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const model = { ...baseModel, contextWindow };

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				throw new Error("streamFn must not run when the prompt airlock refuses");
			},
		});

		const authStorage = AuthStorage.fromStorage({
			read: () => JSON.stringify({ anthropic: { apiKey: "test-key" } }),
			withLock: <T>(fn: () => T) => fn(),
			withLockAsync: async <T>(fn: () => Promise<T>) => fn(),
		});
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens } }));
		const settingsManager = SettingsManager.create(tempDir, tempDir);

		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	}

	it("refuses a user message larger than the liveness budget", async () => {
		session = createSession(1000, 100);
		const oversized = "x".repeat(5000);

		await session.prompt(oversized).then(
			() => {
				throw new Error("expected prompt() to reject with PromptExceedsBudgetError");
			},
			(error: unknown) => {
				expect(error).toBeInstanceOf(PromptExceedsBudgetError);
				const err = error as PromptExceedsBudgetError;
				expect(err.estimatedTokens).toBeGreaterThan(err.budgetTokens);
				expect(err.budgetTokens).toBe(900);
				expect(err.modelId).toContain("claude-sonnet-4-5");
			},
		);
	});

	it("accepts a user message within the liveness budget", async () => {
		session = createSession(10000, 100);
		const small = "hello";

		await session.prompt(small).then(
			() => {},
			(error: unknown) => {
				expect(error).not.toBeInstanceOf(PromptExceedsBudgetError);
			},
		);
	});
});

describe("AgentSession prompt airlock — reserve exceeds input budget (P2b)", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-prompt-budget-reserve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) session.dispose();
		session = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("refuses a non-empty prompt when reserveTokens >= effectiveInputBudget", async () => {
		// reserveTokens (2000) >= contextWindow (1000) → liveness budget clamps
		// to 1, so any non-empty prompt exceeds it. Previously the raw budget was
		// non-positive and the airlock silently skipped, letting oversized input
		// through.
		const baseModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const model = { ...baseModel, contextWindow: 1000 };

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				throw new Error("streamFn must not run when the prompt airlock refuses");
			},
		});

		const authStorage = AuthStorage.fromStorage({
			read: () => JSON.stringify({ anthropic: { apiKey: "test-key" } }),
			withLock: <T>(fn: () => T) => fn(),
			withLockAsync: async <T>(fn: () => Promise<T>) => fn(),
		});
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 2000 } }));
		const settingsManager = SettingsManager.create(tempDir, tempDir);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("non-empty prompt that must be refused").then(
			() => {
				throw new Error("expected prompt() to reject with PromptExceedsBudgetError");
			},
			(error: unknown) => {
				expect(error).toBeInstanceOf(PromptExceedsBudgetError);
				const err = error as PromptExceedsBudgetError;
				expect(err.budgetTokens).toBe(1);
				expect(err.estimatedTokens).toBeGreaterThan(1);
			},
		);
	});

	it("refuses a single-character prompt (\"x\") when reserveTokens >= effectiveInputBudget (P2c)", async () => {
		// reserveTokens (2000) >= contextWindow (1000) → raw budget is
		// non-positive. The clamped liveness budget is 1, and a single-character
		// prompt "x" estimates to exactly 1 token (ceil(1/4)=1), so the normal
		// `tokens > liveness.tokens` gate does NOT catch it (1 > 1 is false). The
		// targeted rejection must refuse any non-empty prompt when the raw budget
		// is non-positive, so "x" is refused.
		const baseModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const model = { ...baseModel, contextWindow: 1000 };

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				throw new Error("streamFn must not run when the prompt airlock refuses");
			},
		});

		const authStorage = AuthStorage.fromStorage({
			read: () => JSON.stringify({ anthropic: { apiKey: "test-key" } }),
			withLock: <T>(fn: () => T) => fn(),
			withLockAsync: async <T>(fn: () => Promise<T>) => fn(),
		});
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 2000 } }));
		const settingsManager = SettingsManager.create(tempDir, tempDir);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("x").then(
			() => {
				throw new Error("expected prompt(\"x\") to reject with PromptExceedsBudgetError");
			},
			(error: unknown) => {
				expect(error).toBeInstanceOf(PromptExceedsBudgetError);
				const err = error as PromptExceedsBudgetError;
				expect(err.budgetTokens).toBe(1);
				expect(err.estimatedTokens).toBeGreaterThanOrEqual(1);
			},
		);
	});
});

// ===========================================================================
// Streaming-queue airlock (P2): steer / followUp / sendUserMessage deliverAs
// ===========================================================================

describe("AgentSession prompt airlock — streaming-queue bypass (P2)", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-prompt-budget-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.abort();
			session.dispose();
		}
		session = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function createStreamingSession(contextWindow: number, reserveTokens: number): AgentSession {
		const baseModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const model = { ...baseModel, contextWindow };
		let abortSignal: AbortSignal | undefined;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_m, _c, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const authStorage = AuthStorage.fromStorage({
			read: () => JSON.stringify({ anthropic: { apiKey: "test-key" } }),
			withLock: <T>(fn: () => T) => fn(),
			withLockAsync: async <T>(fn: () => Promise<T>) => fn(),
		});
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens } }));
		const settingsManager = SettingsManager.create(tempDir, tempDir);

		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	}

	it("refuses an oversized steer() call before it enters the queue", async () => {
		session = createStreamingSession(1000, 100);
		const firstPrompt = session.prompt("start streaming");
		await waitFor(() => session!.isStreaming);

		const oversized = "y".repeat(5000);

		await expect(session.steer(oversized)).rejects.toBeInstanceOf(PromptExceedsBudgetError);

		// Nothing was queued: the airlock threw before _queueSteer ran.
		expect(drainQueuedTexts(session.agent)).toEqual({ steering: [], followUp: [] });

		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("refuses an oversized followUp() call before it enters the queue", async () => {
		session = createStreamingSession(1000, 100);
		const firstPrompt = session.prompt("start streaming");
		await waitFor(() => session!.isStreaming);

		const oversized = "z".repeat(5000);

		await expect(session.followUp(oversized)).rejects.toBeInstanceOf(PromptExceedsBudgetError);

		expect(drainQueuedTexts(session.agent)).toEqual({ steering: [], followUp: [] });

		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("refuses an oversized sendUserMessage deliverAs steer before it enters the queue", async () => {
		session = createStreamingSession(1000, 100);
		const firstPrompt = session.prompt("start streaming");
		await waitFor(() => session!.isStreaming);

		const oversized = "w".repeat(5000);

		await expect(
			session.sendUserMessage(oversized, { deliverAs: "steer" }),
		).rejects.toBeInstanceOf(PromptExceedsBudgetError);

		expect(drainQueuedTexts(session.agent)).toEqual({ steering: [], followUp: [] });

		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("accepts a small steer() call within budget", async () => {
		session = createStreamingSession(10000, 100);
		const firstPrompt = session.prompt("start streaming");
		await waitFor(() => session!.isStreaming);

		await session.steer("small steer");

		expect(drainQueuedTexts(session.agent)).toEqual({ steering: ["small steer"], followUp: [] });

		await session.abort();
		await firstPrompt.catch(() => {});
	});
});
