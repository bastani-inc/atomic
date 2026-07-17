import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { VerbatimCompactionApplyOptions } from "../src/core/agent-session-methods.ts";
import { CACHE_REUSE_COLLAPSE_DIRECTIVE } from "../src/core/compaction/collapse-planner.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { prepareFullCollapseBoundary } from "../src/core/compaction/full-collapse-boundary.ts";
import type { NumberedRegion, VerbatimCompactionDetails } from "../src/core/compaction/compaction-types.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { CompactionEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model: Model<"anthropic-messages"> = {
	id: "collapse-test", name: "Collapse Test", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.com",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
};

function assistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "collapse-test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp,
	};
}

function toolResult(text: string, timestamp: number): AgentMessage {
	return { role: "toolResult", toolCallId: `tc-${timestamp}`, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp };
}

/** A valid subsequence: keep line 1 plus every protected line, delete the rest. */
function validCollapseOutput(region: NumberedRegion): string {
	const keep = new Set<number>([1, ...(region.protectedLineNumbers ?? [])]);
	return region.lines.filter((_, index) => keep.has(index + 1)).join("\n");
}

interface Capture {
	context: Context;
	options?: SimpleStreamOptions;
}

/**
 * A stream function that returns a caller-staged compacted string with staged
 * cache usage, mimicking the provider serving the cached old-conversation prefix.
 */
function stagedStreamFn(getResponse: () => { text: string; usage: Partial<Usage> }, calls: Capture[]) {
	return (_model: Model<"anthropic-messages">, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		calls.push({ context, options });
		const { text, usage } = getResponse();
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "anthropic", model: "collapse-test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage },
			stopReason: "stop", timestamp: Date.now(),
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

describe("repeated overflow full-collapse in one logical turn", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;
	let pending: { text: string; usage: Partial<Usage> };
	let calls: Capture[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-overflow-repro-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		calls = [];
		pending = { text: "", usage: {} };

		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: { model, systemPrompt: "You are the ACTIVE coding agent system prompt.", tools: [] },
			streamFn: stagedStreamFn(() => pending, calls),
		});

		// One logical turn: a single user message followed by hundreds of
		// assistant/tool entries (the incident shape) with NO later user turn.
		sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "kick off the long task\nwith much detail" }], timestamp: 1 });
		for (let i = 0; i < 300; i++) {
			sessionManager.appendMessage(i % 2 === 0 ? assistant(`step ${i}\nwork line ${i}`, i + 2) : toolResult(`result ${i}\noutput line ${i}`, i + 2));
		}

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "faux-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		session = new AgentSession({ agent, sessionManager, settingsManager, cwd: tempDir, modelRegistry, resourceLoader: createTestResourceLoader() });
	});

	afterEach(() => {
		session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function overflowOptions(): VerbatimCompactionApplyOptions {
		return {
			resolvePlannerAuth: async () => ({ apiKey: "faux-key" }),
			abortController: new AbortController(),
			backupLabel: "overflow",
			reason: "overflow",
			preserve_recent: 2,
		};
	}

	it("recovers from overflow, reuses the cache prefix, and repeats within the same turn with telemetry", async () => {
		// ---- Round 1: overflow inside one huge logical turn no longer dead-ends.
		const prep1 = prepareFullCollapseBoundary(sessionManager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		expect(prep1).toBeDefined();
		pending = { text: validCollapseOutput(prep1.region), usage: { cacheRead: 4096, cacheWrite: 128 } };

		const result1 = await session._applyVerbatimCompaction(overflowOptions());
		expect(result1).toBeDefined();
		expect(result1?.format).toBe("full-collapse");
		// Cache telemetry fixture: nonzero provider cache-read => a hit.
		expect(result1?.cache).toMatchObject({ cacheHit: true, cacheReadTokens: 4096, cacheWriteTokens: 128, provider: "anthropic" });

		// The persisted boundary carries the same cache telemetry in its details.
		const boundary1 = sessionManager.getEntries().filter((entry) => entry.type === "compaction").at(-1) as CompactionEntry<VerbatimCompactionDetails>;
		expect(boundary1.details?.format).toBe("full-collapse");
		expect(boundary1.details?.cache).toMatchObject({ cacheHit: true, cacheReadTokens: 4096 });

		// The compaction request reused the active prefix and appended the
		// instruction after the cache breakpoint (with the provider hook attached).
		const call1 = calls[0];
		const appended = call1.context.messages[call1.context.messages.length - 1];
		const appendedText = Array.isArray(appended.content) && appended.content[0].type === "text" ? appended.content[0].text : "";
		expect(appendedText).toContain(CACHE_REUSE_COLLAPSE_DIRECTIVE);
		expect(call1.context.systemPrompt).toBe(session.agent.state.systemPrompt);
		expect(call1.options?.sessionId).toBe(session.sessionId);
		expect(typeof call1.options?.onPayload).toBe("function");

		// ---- Same logical turn: append more assistant/tool work, NO new user turn.
		for (let i = 0; i < 40; i++) {
			sessionManager.appendMessage(i % 2 === 0 ? assistant(`more ${i}\ntail ${i}`, 10_000 + i) : toolResult(`out ${i}\ntail ${i}`, 10_000 + i));
		}

		// ---- Round 2: overflow recovery repeats (collapses prior string + new work).
		const prep2 = prepareFullCollapseBoundary(sessionManager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		expect(prep2).toBeDefined();
		pending = { text: validCollapseOutput(prep2.region), usage: { cacheRead: 8192, cacheWrite: 64 } };

		const result2 = await session._applyVerbatimCompaction(overflowOptions());
		expect(result2).toBeDefined();
		expect(result2?.cache).toMatchObject({ cacheHit: true, cacheReadTokens: 8192 });
		expect(calls).toHaveLength(2);

		// Two boundaries were written in one logical turn; the latest is v2.
		const boundaries = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(boundaries).toHaveLength(2);
	});
});
