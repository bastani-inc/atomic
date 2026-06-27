/** Regression coverage for prompt airlock ordering with pending bash output. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { BashResult } from "../src/core/bash-executor.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { PromptExceedsBudgetError } from "../src/core/prompt-budget.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

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

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("AgentSession prompt airlock — pending bash ordering", () => {
	let session: AgentSession | undefined;
	let tempDir = "";

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-prompt-budget-bash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.abort();
			session.dispose();
		}
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(contextWindow: number, reserveTokens: number): { session: AgentSession; sessionManager: SessionManager } {
		const baseModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const model = { ...baseModel, contextWindow };
		let holdFirstStream = true;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistantMessage("") });
					if (!holdFirstStream) {
						const done = assistantMessage("done");
						stream.push({ type: "done", reason: "stop", message: done });
						stream.end(done);
						return;
					}
					holdFirstStream = false;
					const waitForAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: assistantMessage("Aborted", "aborted") });
						} else {
							setTimeout(waitForAbort, 5);
						}
					};
					waitForAbort();
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
		const sessionManager = SessionManager.inMemory(tempDir);
		return {
			session: new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: tempDir,
				modelRegistry,
				resourceLoader: createTestResourceLoader(),
			}),
			sessionManager,
		};
	}

	it("does not flush pending bash output before refusing an oversized prompt", async () => {
		const created = createSession(1000, 100);
		session = created.session;
		const firstPrompt = session.prompt("start streaming");
		await waitFor(() => session!.isStreaming);

		const bashResult: BashResult = { output: "pending output", exitCode: 0, cancelled: false, truncated: false };
		session.recordBashResult("echo pending", bashResult);
		expect(session.hasPendingBashMessages).toBe(true);

		await session.abort();
		await firstPrompt.catch(() => undefined);
		await waitFor(() => !session!.isStreaming);

		const hasBashInState = () => session!.agent.state.messages.some((message) => message.role === "bashExecution");
		const hasPersistedBash = () => created.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "bashExecution");

		await expect(session.prompt("x".repeat(5000))).rejects.toBeInstanceOf(PromptExceedsBudgetError);
		expect(session.hasPendingBashMessages).toBe(true);
		expect(hasBashInState()).toBe(false);
		expect(hasPersistedBash()).toBe(false);

		await session.prompt("small prompt");
		expect(session.hasPendingBashMessages).toBe(false);
		expect(hasBashInState()).toBe(true);
		expect(hasPersistedBash()).toBe(true);
	});
});
