import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";
import { appendTestCompaction } from "./verbatim-compaction-test-helpers.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessageWithUsage(text: string, usage: Usage, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function createAssistantMessage(text: string, totalTokens: number, timestamp: number): AssistantMessage {
	return createAssistantMessageWithUsage(text, createUsage(totalTokens), timestamp);
}

function createUserMessage(text: string, timestamp: number) {
	return {
		role: "user" as const,
		content: text,
		timestamp,
	};
}


function createSession() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});

	return { session, sessionManager };
}

function syncAgentMessages(session: AgentSession, sessionManager: SessionManager): void {
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
}

describe("AgentSession.getSessionStats", () => {
	it("exposes the current context usage alongside token totals", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toEqual(session.getContextUsage());
			expect(stats.contextUsage?.tokens).toBe(200);
			expect(stats.contextUsage?.contextWindow).toBe(model.contextWindow);
			expect(stats.contextUsage?.percent).toBe((200 / model.contextWindow) * 100);
		} finally {
			session.dispose();
		}
	});

	it("reports unknown current context usage immediately after context compaction", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			appendTestCompaction(sessionManager, 195_000, 50_000);
			sessionManager.appendMessage(createUserMessage("third", Date.now() + 1));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBeNull();
			expect(stats.contextUsage?.percent).toBeNull();
		} finally {
			session.dispose();
		}
	});

	it("uses post-context-compaction usage for current context instead of stale kept usage (duplicate check)", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			appendTestCompaction(sessionManager, 195_000, 50_000);
			sessionManager.appendMessage(createUserMessage("third", Date.now() + 1));
			sessionManager.appendMessage(createAssistantMessage("response3", 25_000, Date.now() + 2));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBe(25_000);
			expect(stats.contextUsage?.percent).toBe((25_000 / model.contextWindow) * 100);
		} finally {
			session.dispose();
		}
	});

	it("reports unknown current context usage immediately after context compaction", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 195_000, 2));
			appendTestCompaction(sessionManager, 195_000, 50_000);
			sessionManager.appendMessage(createUserMessage("second", Date.now() + 1));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBeNull();
			expect(stats.contextUsage?.percent).toBeNull();
		} finally {
			session.dispose();
		}
	});

	it("uses post-context-compaction usage for current context instead of stale kept usage", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 195_000, 2));
			appendTestCompaction(sessionManager, 195_000, 50_000);
			sessionManager.appendMessage(createUserMessage("second", Date.now() + 1));
			sessionManager.appendMessage(createAssistantMessage("response2", 25_000, Date.now() + 2));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBe(25_000);
			expect(stats.contextUsage?.percent).toBe((25_000 / model.contextWindow) * 100);
		} finally {
			session.dispose();
		}
	});

	it("does not double-count mirrored cache buckets in post-compaction context usage", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 195_000, 2));
			appendTestCompaction(sessionManager, 216_006, 81_414);
			sessionManager.appendMessage(createUserMessage("second", Date.now() + 1));
			sessionManager.appendMessage(
				createAssistantMessageWithUsage(
					"response2",
					{
						input: 116_000,
						output: 500,
						cacheRead: 116_000,
						cacheWrite: 0,
						totalTokens: 232_500,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					Date.now() + 2,
				),
			);
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBe(116_500);
			expect(stats.contextUsage?.percent).toBe((116_500 / model.contextWindow) * 100);
		} finally {
			session.dispose();
		}
	});

	it("counts normalized Codex cache partitions in post-compaction context usage", () => {
		const { session, sessionManager } = createSession();
		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 195_000, 2));
			appendTestCompaction(sessionManager, 195_000, 50_000);
			sessionManager.appendMessage(createUserMessage("second", Date.now() + 1));
			sessionManager.appendMessage({
				...createAssistantMessageWithUsage("response2", {
					input: 7_907, output: 7, cacheRead: 7_936, cacheWrite: 0, totalTokens: 15_850,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				}, Date.now() + 2),
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.5",
			});
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage?.tokens).toBe(15_850);
			expect(stats.contextUsage?.percent).toBe((15_850 / model.contextWindow) * 100);
		} finally {
			session.dispose();
		}
	});
});
