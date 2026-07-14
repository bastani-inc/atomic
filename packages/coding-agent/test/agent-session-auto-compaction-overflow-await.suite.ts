import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

vi.mock("../src/core/compaction/index.js", () => ({
	VERBATIM_COMPACTION_PROMPT_VERSION: 3,
	VERBATIM_COMPACTION_STRATEGY: "verbatim-lines",
	calculateContextTokens: () => 0,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	runVerbatimCompaction: async () => ({
		text: "[User]: retained test context\n(filtered 1 lines)", ranges: [{ start: 2, end: 2 }],
		stats: { linesBefore: 2, linesDeleted: 1, linesKept: 1, rangeCount: 1, tokensBefore: 100, tokensAfter: 50, percentReduction: 50 },
		rung: "planned" as const,
	}),
	estimateContextTokens: () => ({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null }),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompactionBoundary: (entries: Array<{ id: string }>) => entries[0] ? ({
		firstKeptEntryId: entries[0].id,
		region: { __brand: "NumberedRegion", lines: ["[User]: test", "body"], headerLineNumbers: new Set([1]), priorMarkerNs: new Map(), tokenEstimate: 10 },
		regionEntryIds: [entries[0].id], keptTailMessageCount: 1, tokensBefore: 100,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
		settings: { enabled: true, reserveTokens: 16384, compression_ratio: 0.5, preserve_recent: 2 },
	}) : undefined,
	shouldCompact: () => false,
}));

describe("AgentSession overflow auto-compaction continuation", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-overflow-continuation-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, tempDir),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("waits for overflow retry continuation before prompt resolves", async () => {
		session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "existing compactable context" }], timestamp: Date.now() });
		let promptResolved = false;
		let continued = false;
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(session);
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			await runAutoCompaction("overflow", true);
		});
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continued = true;
		});
		vi.spyOn(session, "waitForRetry").mockResolvedValue();

		const promptPromise = session.prompt("retry after overflow").then(() => {
			promptResolved = true;
		});
		await vi.advanceTimersByTimeAsync(99);

		expect(promptResolved).toBe(false);
		expect(continued).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await promptPromise;

		expect(continued).toBe(true);
		expect(promptResolved).toBe(true);
	});
});
