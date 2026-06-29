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
} from "@earendil-works/pi-ai/compat";
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

	it("should hold messages queued immediately after interrupt enqueue before the interrupt turn starts", async () => {
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

		const steerSpy = vi.spyOn(session.agent, "steer");
		const followUpSpy = vi.spyOn(session.agent, "followUp");
		const interrupt = session.sendCustomMessage(
			{ customType: "test:interrupt", content: "Interrupt notice", display: true },
			{ triggerTurn: true, deliverAs: "interrupt" },
		);

		await session.steer("Queued B");
		await session.followUp("Queued C");
		await session.sendCustomMessage(
			{ customType: "test:queued-custom", content: "Queued custom follow-up", display: true },
			{ deliverAs: "followUp" },
		);

		expect(steerSpy).not.toHaveBeenCalled();
		expect(followUpSpy).not.toHaveBeenCalled();
		await waitFor(() => interruptTurnStarted);

		finishInterruptTurn?.();
		await interrupt;
		await firstPrompt.catch(() => {});

		expect(session.pendingMessageCount).toBe(3);
		expect(drainQueuedTexts(session.agent)).toEqual({
			steering: ["Queued A", "Queued B"],
			followUp: ["Queued C", "Queued custom follow-up"],
		});
	});
	it("should restore only messages queued after clearQueue during an interrupt", async () => {
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

		expect(session.clearQueue()).toEqual({ steering: ["Queued A"], followUp: [] });
		await session.steer("Queued C");

		finishInterruptTurn?.();
		await interrupt;
		await firstPrompt.catch(() => {});

		expect(session.pendingMessageCount).toBe(1);
		expect(drainQueuedTexts(session.agent)).toEqual({ steering: ["Queued C"], followUp: [] });
	});
	it("should clear interrupt-held queues while the interrupt custom-message turn is pending", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let abortObserved = false;
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

					const hasInterruptMessage = userTexts.some((text) =>
						text.includes("The workflow prompt was answered"),
					);
					if (hasInterruptMessage) {
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
							abortObserved = true;
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

		await session.steer("Queued steer");
		await session.followUp("Queued follow-up");
		expect(session.pendingMessageCount).toBe(2);

		const interrupt = session.sendCustomMessage(
			{
				customType: "test:interrupt",
				content: "The workflow prompt was answered. Do not ask again.",
				display: true,
			},
			{ triggerTurn: true, deliverAs: "interrupt" },
		);

		await waitFor(() => interruptTurnStarted && abortObserved);

		const cleared = session.clearQueue();
		expect(cleared).toEqual({ steering: ["Queued steer"], followUp: ["Queued follow-up"] });
		expect(session.pendingMessageCount).toBe(0);

		finishInterruptTurn?.();
		await interrupt;
		await firstPrompt.catch(() => {});

		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});
});
