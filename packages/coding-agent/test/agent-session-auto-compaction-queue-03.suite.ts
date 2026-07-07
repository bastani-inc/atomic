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
}));

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number }) =>
		usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, details: {} }),
	contextCompact: compactionMocks.contextCompact,
	estimateContextTokens: () => ({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null }),
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
});
