import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { scrubPreCompactionAssistantUsage } from "../src/core/provider-context-usage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { getLatestCompactionBoundaryEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";
import { appendTestCompaction } from "./verbatim-compaction-test-helpers.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createUsage(tokens: number): Usage {
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	};
}

function createAssistantMessage(text: string, timestamp: number, usage: Usage): AssistantMessage {
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

function createUserMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function getAssistantAt(messages: AgentMessage[], index: number): AssistantMessage {
	const message = messages[index];
	expect(message?.role).toBe("assistant");
	return message as AssistantMessage;
}

describe("provider-bound context usage", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-provider-context-usage-"));
		cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("scrubs stale pre-compaction assistant usage before provider conversion", async () => {
		const sessionManager = SessionManager.inMemory(cwd);
		const oldUsage: Usage = {
			...createUsage(267_857),
			output: 253,
			reasoning: 118,
			cacheWrite1h: 42,
		};
		const oldAssistant = createAssistantMessage("pre-compaction answer", 1, oldUsage);

		sessionManager.appendMessage(createUserMessage("before", 0));
		appendTestCompaction(sessionManager, 243_928, 84_731);
		// Retained pre-boundary messages are concatenated into the boundary text, so the stale
		// usage anchors that still reach the provider are messages carrying pre-boundary timestamps.
		sessionManager.appendMessage(oldAssistant);
		sessionManager.appendMessage(createUserMessage("continue", Date.now() + 1));

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
		const { session } = await createAgentSession({
			cwd,
			model,
			authStorage,
			modelRegistry: await createInMemoryModelRegistry(authStorage),
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});

		try {
			expect(session.agent.transformContext).toBeDefined();
			const transformed = await session.agent.transformContext!(session.agent.state.messages);
			const transformedAssistant = getAssistantAt(transformed, 1);
			const durableAssistant = getAssistantAt(session.agent.state.messages, 1);

			expect(transformedAssistant.content).toEqual(oldAssistant.content);
			expect(transformedAssistant.usage).toMatchObject({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				reasoning: 0,
				cacheWrite1h: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			});
			expect(durableAssistant.usage.totalTokens).toBe(267_857);
			expect(durableAssistant.usage.cost.total).toBe(10);
		} finally {
			session.dispose();
		}
	});

	it("preserves fresh post-compaction usage while scrubbing older retained usage", () => {
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage(createUserMessage("before", 0));
		appendTestCompaction(sessionManager, 243_928, 84_731);
		const boundary = getLatestCompactionBoundaryEntry(sessionManager.getBranch());
		expect(boundary).not.toBeNull();

		sessionManager.appendMessage(createAssistantMessage("old", 1, createUsage(267_857)));
		const postCompactionTimestamp = Date.parse(boundary!.timestamp) + 1;
		sessionManager.appendMessage(createUserMessage("after", postCompactionTimestamp));
		sessionManager.appendMessage(createAssistantMessage("fresh", postCompactionTimestamp + 1, createUsage(25_000)));

		const messages = sessionManager.buildSessionContext().messages;
		const transformed = scrubPreCompactionAssistantUsage(messages, sessionManager.getBranch());

		expect(getAssistantAt(transformed, 1).usage.totalTokens).toBe(0);
		expect(getAssistantAt(transformed, 3).usage.totalTokens).toBe(25_000);
		expect(getAssistantAt(messages, 1).usage.totalTokens).toBe(267_857);
	});
});
