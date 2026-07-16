import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	calculateContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	getLastAssistantUsage,
	shouldCompact,
} from "../src/core/compaction/index.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type ContextCompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../src/core/session-manager.ts";
import { readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// Test fixtures
// ============================================================================

function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

/**
 * Creates a legacy CompactionEntry fixture for testing that old sessions with
 * type:"compaction" records are treated as archival/inert at runtime.
 */
function createLegacyCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function createContextCompactionEntry(targets: ContextCompactionEntry["deletedTargets"]): ContextCompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ContextCompactionEntry = {
		type: "context_compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		promptVersion: 1,
		deletedTargets: targets,
		protectedEntryIds: [],
		stats: {
			objectsBefore: 0,
			objectsAfter: 0,
			objectsDeleted: targets.length,
			tokensBefore: 0,
			tokensAfter: 0,
			percentReduction: 0,
		},
	};
	lastId = id;
	return entry;
}

function createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
	lastId = id;
	return entry;
}

function createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

// ============================================================================
// Unit tests — metrics helpers
// ============================================================================

describe("Token calculation", () => {
	it("calculates active context tokens from usage components", () => {
		const usage = createMockUsage(1000, 500, 200, 100);
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("ignores bogus totalTokens when component usage is available", () => {
		const usage: Usage = {
			...createMockUsage(1000, 500, 200, 100),
			totalTokens: 999_999,
		};
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("does not double-count mirrored Anthropic-compatible cache buckets", () => {
		const usage = createMockUsage(116_000, 500, 116_000, 0);
		expect(calculateContextTokens(usage, "anthropic-messages")).toBe(116_500);
	});

	it("counts disjoint Codex cache buckets even when they nearly equal uncached input", () => {
		const usage = createMockUsage(7_907, 7, 7_936, 0);
		expect(calculateContextTokens(usage, "openai-codex-responses")).toBe(15_850);
	});

	it("keeps separate Anthropic cache partitions when cache is not mirrored input", () => {
		const usage = createMockUsage(35_000, 500, 81_000, 0);
		expect(calculateContextTokens(usage, "anthropic-messages")).toBe(116_500);
	});

	it("falls back to totalTokens when component values are unavailable", () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1234,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(calculateContextTokens(usage)).toBe(1234);
	});

	it("handles zero values", () => {
		const usage = createMockUsage(0, 0, 0, 0);
		expect(calculateContextTokens(usage)).toBe(0);
	});
});

describe("getLastAssistantUsage", () => {
	it("should find the last non-aborted assistant message usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(createAssistantMessage("Good", createMockUsage(200, 100))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(200);
	});

	it("should skip aborted messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(abortedMsg),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should return undefined if no assistant messages", () => {
		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Hello"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("shouldCompact", () => {
	it("should return true when context exceeds threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(89000, 100000, settings)).toBe(false);
	});

	it("should return false when disabled", () => {
		const settings: CompactionSettings = {
			enabled: false,
			reserveTokens: 10000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(false);
	});
});

describe("estimateContextTokens", () => {
	it("keeps malformed and future user-like token estimates finite and visibility-aligned", () => {
		const cyclicBlock: Record<string, unknown> = { type: "audio", data: "cyclic-future-payload" };
		cyclicBlock.self = cyclicBlock;
		const invalidText = {
			role: "user",
			content: [{ type: "text", text: 42 }],
			timestamp: 1,
		} as unknown as AgentMessage;
		const malformed = { role: "user", content: [{ data: "untyped" }], timestamp: 2 } as unknown as AgentMessage;
		const future = {
			role: "custom",
			customType: "future",
			content: [{ type: "audio", data: "future-provider-payload" }],
			display: true,
			timestamp: 3,
		} as unknown as AgentMessage;
		const cyclic = { role: "user", content: [cyclicBlock], timestamp: 4 } as unknown as AgentMessage;

		expect(estimateTokens(invalidText)).toBe(0);
		expect(estimateTokens(malformed)).toBe(0);
		expect(estimateTokens(future)).toBeGreaterThan(0);
		expect(estimateTokens(cyclic)).toBeGreaterThan(0);
		for (const message of [invalidText, malformed, future, cyclic]) {
			expect(Number.isFinite(estimateTokens(message))).toBe(true);
		}
		const total = estimateContextTokens([invalidText, malformed, future, cyclic]);
		expect(Number.isFinite(total.tokens)).toBe(true);
		expect(total.tokens).toBe(estimateTokens(future) + estimateTokens(cyclic));
	});

	it("should return the last non-aborted assistant usage tokens", () => {
		const messages: AgentMessage[] = [
			createUserMessage("hello"),
			createAssistantMessage("response", createMockUsage(100, 50)),
		];
		const result = estimateContextTokens(messages);
		expect(result.tokens).toBe(150);
	});

	it("preserves the API discriminator for normalized cached usage", () => {
		const usage = createMockUsage(7_907, 7, 7_936, 0);
		const message = { ...createAssistantMessage("response", usage), api: "openai-codex-responses" as const, provider: "openai-codex" };
		const result = estimateContextTokens([createUserMessage("hello"), message]);
		expect(result.tokens).toBe(15_850);
		expect(shouldCompact(result.tokens, 20_000, { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 5_000 })).toBe(true);
	});

	it("should return zero tokens for empty messages", () => {
		const result = estimateContextTokens([]);
		expect(result.tokens).toBe(0);
	});

	it("should skip aborted assistant messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};
		const messages: AgentMessage[] = [
			createUserMessage("hello"),
			createAssistantMessage("ok", createMockUsage(50, 30)),
			createUserMessage("again"),
			abortedMsg,
		];
		const result = estimateContextTokens(messages);
		// usageTokens reflects only the last non-aborted assistant (50+30=80);
		// tokens also includes trailing message estimates after that assistant.
		expect(result.usageTokens).toBe(80);
		expect(result.tokens).toBeGreaterThanOrEqual(80);
		expect(result.lastUsageIndex).toBe(1); // index of "ok" assistant message
	});

	it("ignores assistant usage older than a newer inserted prefix", () => {
		const messages: AgentMessage[] = [
			{ ...createUserMessage("new prefix"), timestamp: 2_000 },
			{ ...createAssistantMessage("old reply", createMockUsage(1_000_000, 100_000)), timestamp: 1_000 },
			{ ...createUserMessage("tail"), timestamp: 3_000 },
		];

		const result = estimateContextTokens(messages);
		const heuristicTokens = messages.reduce((total, message) => total + estimateTokens(message), 0);

		expect(result).toEqual({
			tokens: heuristicTokens,
			usageTokens: 0,
			trailingTokens: heuristicTokens,
			lastUsageIndex: null,
		});
		expect(shouldCompact(result.tokens, 100_000, { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 10_000 })).toBe(false);
	});
});

// ============================================================================
// buildSessionContext — legacy compaction entries are archival/inert
// ============================================================================

describe("buildSessionContext", () => {
	it("should load all messages when no compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a")),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b")),
		];

		const loaded = buildSessionContext(entries);
		expect(loaded.messages.length).toBe(4);
		expect(loaded.thinkingLevel).toBe("off");
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});

	it("legacy type:compaction entries are inert — all messages still included", () => {
		// Old sessions may contain type:"compaction" entries on disk.
		// These must NOT inject a compactionSummary message or act as a context boundary.
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const a2 = createMessageEntry(createAssistantMessage("b"));
		const compaction = createLegacyCompactionEntry("Summary of 1,a,2,b", u2.id);
		const u3 = createMessageEntry(createUserMessage("3"));
		const a3 = createMessageEntry(createAssistantMessage("c"));

		const entries: SessionEntry[] = [u1, a1, u2, a2, compaction, u3, a3];

		const loaded = buildSessionContext(entries);
		// Legacy compaction entry is ignored — all 6 real messages are active.
		// No compactionSummary is injected.
		expect(loaded.messages.length).toBe(6);
		expect(loaded.messages.every((m) => m.role !== "compactionSummary")).toBe(true);
	});

	it("multiple legacy compaction entries are all inert", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createLegacyCompactionEntry("First summary", u1.id);
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));
		const u3 = createMessageEntry(createUserMessage("3"));
		const c = createMessageEntry(createAssistantMessage("c"));
		const compact2 = createLegacyCompactionEntry("Second summary", u3.id);
		const u4 = createMessageEntry(createUserMessage("4"));
		const d = createMessageEntry(createAssistantMessage("d"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b, u3, c, compact2, u4, d];

		const loaded = buildSessionContext(entries);
		// Both legacy compaction entries are ignored — all 8 real messages are active.
		expect(loaded.messages.length).toBe(8);
		expect(loaded.messages.every((m) => m.role !== "compactionSummary")).toBe(true);
	});

	it("should track model and thinking level changes", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createModelChangeEntry("openai", "gpt-4"),
			createMessageEntry(createAssistantMessage("a")),
			createThinkingLevelEntry("high"),
		];

		const loaded = buildSessionContext(entries);
		// model_change is later overwritten by assistant message's model info
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});

	it("legacy context_compaction entries are inert archival records", () => {
		const u1 = createMessageEntry(createUserMessage("old user task"));
		const wholeDeleted = createMessageEntry(createAssistantMessage("WHOLE_ENTRY_DELETED"));
		const partialDeleted = createMessageEntry({
			...createAssistantMessage(""),
			content: [
				{ type: "text", text: "DELETED_BLOCK" },
				{ type: "text", text: "RETAINED_BLOCK" },
			],
		});
		const currentUser = createMessageEntry(createUserMessage("current task"));
		const logicalDeletion = createContextCompactionEntry([
			{ kind: "entry", entryId: wholeDeleted.id },
			{ kind: "content_block", entryId: partialDeleted.id, blockIndex: 0 },
		]);
		const suffix = createMessageEntry(createAssistantMessage("current suffix kept"));
		const entries: SessionEntry[] = [u1, wholeDeleted, partialDeleted, currentUser, logicalDeletion, suffix];

		const loaded = buildSessionContext(entries);

		expect(loaded.messages.find((message) => message.role === "assistant" && message.content.some(
			(block) => block.type === "text" && block.text === "WHOLE_ENTRY_DELETED",
		))).toBeDefined();
		expect(loaded.messages.find((message) => message.role === "assistant" && message.content.some(
			(block) => block.type === "text" && block.text === "RETAINED_BLOCK",
		))).toBeDefined();
		expect(loaded.messages.find((message) => message.role === "assistant" && message.content.some(
			(block) => block.type === "text" && block.text === "DELETED_BLOCK",
		))).toBeDefined();
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should parse the large session", () => {
		const entries = loadLargeSessionEntries();
		expect(entries.length).toBeGreaterThan(100);

		const messageCount = entries.filter((e) => e.type === "message").length;
		expect(messageCount).toBeGreaterThan(100);
	});

	it("should load session correctly", () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);

		expect(loaded.messages.length).toBeGreaterThan(100);
		expect(loaded.model).not.toBeNull();
	});

	it("DEFAULT_COMPACTION_SETTINGS has no keepRecentTokens", () => {
		// Verify the metrics-only settings shape does not include legacy keepRecentTokens
		expect((DEFAULT_COMPACTION_SETTINGS as Record<string, unknown>)["keepRecentTokens"]).toBeUndefined();
		expect(DEFAULT_COMPACTION_SETTINGS.enabled).toBe(true);
		expect(DEFAULT_COMPACTION_SETTINGS.reserveTokens).toBeGreaterThan(0);
	});
});
