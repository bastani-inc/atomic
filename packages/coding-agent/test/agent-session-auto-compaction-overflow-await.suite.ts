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
	calculateContextTokens: () => 0,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, details: {} }),
	contextCompact: async () => ({
		deletedTargets: [{ kind: "entry", entryId: "entry-1" }],
		protectedEntryIds: [],
		stats: {
			objectsBefore: 1,
			objectsAfter: 1,
			objectsDeleted: 0,
			tokensBefore: 100,
			tokensAfter: 50,
			percentReduction: 50,
		},
	}),
	estimateContextTokens: () => ({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null }),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareContextCompaction: () => ({ dummy: true }),
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
