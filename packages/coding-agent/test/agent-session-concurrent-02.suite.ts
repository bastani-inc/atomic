/**
 * Tests for AgentSession concurrent prompt guard.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type TextContent,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BuildSystemPromptOptions } from "../src/core/system-prompt.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

// Mock stream that mimics AssistantMessageEventStream
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

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
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
	if (typeof message.content === "string") {
		return message.content;
	}
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

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-concurrent-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		delete (globalThis as typeof globalThis & { testExtensionApi?: unknown }).testExtensionApi;
		delete (globalThis as typeof globalThis & { testCommandRuns?: unknown }).testCommandRuns;
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;

		// Use a stream function that responds to abort
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, _context, options) => {
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

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		// Set a runtime API key so validation passes
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return session;
	}


	it("should replace generic abort events for interrupt custom messages", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const abortMessage =
			"The main-chat question was dismissed because the user responded in the workflow chat. User responded with: Blue.";
		const internals = session as unknown as {
			_activeInterruptAbortMessage: string | undefined;
			_applyInterruptAbortMessage(event: AgentEvent): void;
		};
		internals._activeInterruptAbortMessage = abortMessage;

		const toolEndEvent = {
			type: "tool_execution_end",
			toolCallId: "ask-1",
			toolName: "ask_user_question",
			result: { content: [{ type: "text" as const, text: "Operation aborted" }], details: {} },
			isError: true,
		} as AgentEvent;
		internals._applyInterruptAbortMessage(toolEndEvent);
		expect((toolEndEvent as { result: { content: TextContent[] } }).result.content[0]?.text).toBe(abortMessage);

		const toolResultEvent = {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "ask-1",
				toolName: "ask_user_question",
				content: [{ type: "text" as const, text: "The operation was aborted." }],
				details: {},
				isError: true,
				timestamp: Date.now(),
			},
		} as AgentEvent;
		internals._applyInterruptAbortMessage(toolResultEvent);
		expect(textFromAgentMessage((toolResultEvent as { message: AgentMessage }).message)).toBe(abortMessage);

		const assistantMessage = { ...createAssistantMessage(""), stopReason: "aborted" as const };
		internals._applyInterruptAbortMessage({ type: "message_start", message: assistantMessage } as AgentEvent);
		expect(assistantMessage.errorMessage).toBe(abortMessage);
	});
	it("should deliver concurrent interrupt custom messages serially", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const startedInterrupts: string[] = [];
		const finishInterrupts: Array<() => void> = [];

		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const userTexts = context.messages
						.filter((message) => message.role === "user")
						.map(textFromAgentMessage);
					const interruptText = userTexts.findLast((text) => text.includes("Interrupt notice"));
					if (interruptText) {
						startedInterrupts.push(interruptText);
						stream.push({ type: "start", partial: createAssistantMessage("") });
						finishInterrupts.push(() => {
							stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Interrupted") });
						});
						return;
					}

					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
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

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);

		const firstInterrupt = session.sendCustomMessage(
			{ customType: "test:interrupt", content: "Interrupt notice 1", display: true },
			{ triggerTurn: true, deliverAs: "interrupt" },
		);
		const secondInterrupt = session.sendCustomMessage(
			{ customType: "test:interrupt", content: "Interrupt notice 2", display: true },
			{ triggerTurn: true, deliverAs: "interrupt" },
		);

		await waitFor(() => startedInterrupts.length === 1 && finishInterrupts.length === 1);
		expect(startedInterrupts[0]).toContain("Interrupt notice 1");
		expect(startedInterrupts).toHaveLength(1);

		finishInterrupts[0]?.();
		await waitFor(() => startedInterrupts.length === 2 && finishInterrupts.length === 2);
		expect(startedInterrupts[1]).toContain("Interrupt notice 2");

		finishInterrupts[1]?.();
		await Promise.all([firstInterrupt, secondInterrupt]);
		await firstPrompt.catch(() => {});
	});
	it("should restore messages queued before and during interrupt in FIFO order", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let interruptTurnStarted = false;
		let finishInterruptTurn: (() => void) | undefined;

		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const userTexts = context.messages
						.filter((message) => message.role === "user")
						.map(textFromAgentMessage);
					if (userTexts.some((text) => text.includes("Interrupt notice"))) {
						interruptTurnStarted = true;
						stream.push({ type: "start", partial: createAssistantMessage("") });
						finishInterruptTurn = () => {
							stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Interrupted") });
						};
						return;
					}

					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
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

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);
		await session.steer("Queued A");

		const interrupt = session.sendCustomMessage(
			{ customType: "test:interrupt", content: "Interrupt notice", display: true },
			{ triggerTurn: true, deliverAs: "interrupt" },
		);
		await waitFor(() => interruptTurnStarted);
		await session.steer("Queued B");

		finishInterruptTurn?.();
		await interrupt;
		await firstPrompt.catch(() => {});

		expect(session.pendingMessageCount).toBe(2);
		expect(drainQueuedTexts(session.agent)).toEqual({ steering: ["Queued A", "Queued B"], followUp: [] });
	});
});
