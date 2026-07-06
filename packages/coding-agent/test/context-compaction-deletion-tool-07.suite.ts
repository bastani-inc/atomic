import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai/compat";
import {
	assistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type CompactableTranscript,
} from "./context-compaction-deletion-tool-helpers.js";
import {
	CONTEXT_COMPACTION_MAX_TURNS,
	contextCompact,
} from "../src/core/compaction/context-compaction-runner.ts";

function preparation(transcript: CompactableTranscript) {
	return { transcript, branchEntries: [] };
}

function textMessage(role: AgentMessage["role"], text: string): AgentMessage {
	return { role, content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function transcript310(): CompactableTranscript {
	const entries: CompactableTranscript["entries"] = [
		{
			entryId: "task",
			entryType: "message",
			role: "user",
			text: "protected task",
			tokenEstimate: 90,
			protected: true,
			contentBlocks: [],
			message: textMessage("user", "protected task"),
			toolCallIds: [],
		},
		{
			entryId: "old-big",
			entryType: "message",
			role: "assistant",
			text: "large stale assistant",
			tokenEstimate: 200,
			protected: false,
			contentBlocks: [],
			message: assistantMessage("large stale assistant"),
			toolCallIds: [],
		},
		{
			entryId: "old-small",
			entryType: "message",
			role: "assistant",
			text: "small stale assistant",
			tokenEstimate: 15,
			protected: false,
			contentBlocks: [],
			message: assistantMessage("small stale assistant"),
			toolCallIds: [],
		},
		...Array.from({ length: 5 }, (_, index) => ({
			entryId: `critical-recent-${index}`,
			entryType: "message" as const,
			role: "assistant" as const,
			text: `critical recent ${index}`,
			tokenEstimate: 1,
			protected: false,
			contentBlocks: [],
			message: assistantMessage(`critical recent ${index}`),
			toolCallIds: [],
		})),
	];
	return { entries, protectedEntryIds: ["task"], tokensBefore: 310, settings: { compressionRatio: 0.5, preserveRecent: 0, reserveTokens: 0 }, parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "test" } };
}

function deleteBig() {
	return fauxAssistantMessage(fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "old-big" }] }));
}

function deleteBoth() {
	return fauxAssistantMessage(
		fauxToolCall("context_delete", {
			deletions: [
				{ kind: "entry", entryId: "old-big" },
				{ kind: "entry", entryId: "old-small" },
			],
		}),
	);
}

function overflowError() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 310 tokens > 100 maximum" });
}

describe("context compaction overflow budget and turn-cap regressions", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("does not commit a tier-1 target-met result that exceeds the overflow budget", async () => {
		const contexts: Context[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(context) => {
				contexts.push(context);
				return deleteBig();
			},
			(context) => {
				contexts.push(context);
				return deleteBoth();
			},
		]);

		const result = await contextCompact(preparation(transcript310()), faux.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 100,
			criticalEvictionTokenBudget: 100,
		});

		expect(result.stats.tokensAfter).toBeLessThanOrEqual(100);
		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "old-big" },
			{ kind: "entry", entryId: "old-small" },
		]);
		expect(JSON.stringify(contexts[1])).toContain("<critical-overflow-mode>");
	});

	it("rejects provider-overflow salvage that meets the strict target but exceeds the overflow budget", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([deleteBig(), overflowError(), deleteBoth()]);

		const result = await contextCompact(preparation(transcript310()), faux.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 100,
			criticalEvictionTokenBudget: 100,
		});

		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "old-big" },
			{ kind: "entry", entryId: "old-small" },
		]);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(100);
	});

	it("falls through to tier-4 when the critical pass meets the strict target but exceeds budget", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("standard unavailable"), deleteBig(), overflowError()]);

		const result = await contextCompact(preparation(transcript310()), faux.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 100,
			criticalEvictionTokenBudget: 100,
		});

		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "old-big" },
			{ kind: "entry", entryId: "old-small" },
		]);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(100);
	});

	it("keeps manual and threshold target-met acceptance unchanged", async () => {
		const manual = registerFauxProvider();
		cleanups.push(() => manual.unregister());
		manual.setResponses([deleteBig()]);
		expect((await contextCompact(preparation(transcript310()), manual.getModel(), "test-key")).stats.tokensAfter).toBe(110);

		const threshold = registerFauxProvider();
		cleanups.push(() => threshold.unregister());
		threshold.setResponses([deleteBig()]);
		const result = await contextCompact(preparation(transcript310()), threshold.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 100,
		});
		expect(result.stats.tokensAfter).toBe(110);
		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "old-big" }]);
	});

	it("caps total planner provider turns even when every turn only calls tools", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses(Array.from({ length: 75 }, () => fauxAssistantMessage(fauxToolCall("context_compaction_budget", {}))));

		await expect(contextCompact(preparation(transcript310()), faux.getModel(), "test-key")).rejects.toThrow(
			/attempt reached 0% with 0 validated deletion target\(s\)/,
		);
		expect(CONTEXT_COMPACTION_MAX_TURNS).toBe(50);
		expect(faux.state.callCount).toBeLessThanOrEqual(CONTEXT_COMPACTION_MAX_TURNS);
	});
});
