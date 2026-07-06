import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai/compat";
import {
	assistantMessage,
	createProtectedTranscript,
	createTranscript,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type CompactableTranscript,
} from "./context-compaction-deletion-tool-helpers.js";
import {
	CONTEXT_COMPACTION_MAX_PLANNER_NUDGES,
	contextCompact,
} from "../src/core/compaction/context-compaction-runner.ts";

function preparation(transcript: CompactableTranscript) {
	return { transcript, branchEntries: [] };
}

function expectProtectedIdsDisjointFromDeleted(result: { protectedEntryIds: string[]; deletedTargets: Array<{ entryId: string }> }) {
	const protectedIds = new Set(result.protectedEntryIds);
	for (const target of result.deletedTargets) {
		expect(protectedIds.has(target.entryId)).toBe(false);
	}
}

function repeatedTextStops() {
	return [fauxAssistantMessage("Stopping before target."), fauxAssistantMessage("Stopping before target again.")];
}

function manyTinyTranscript(count = 60): CompactableTranscript {
	const task: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "Huge protected task anchor." }],
		timestamp: Date.now(),
	};
	const entries: CompactableTranscript["entries"] = [
		{
			entryId: "entry-user",
			entryType: "message",
			role: "user",
			text: "Huge protected task anchor.",
			tokenEstimate: 1000,
			protected: true,
			contentBlocks: [],
			message: task,
			toolCallIds: [],
		},
		...Array.from({ length: count }, (_, index) => ({
			entryId: `entry-old-${index}`,
			entryType: "message" as const,
			role: "assistant" as const,
			text: `tiny ${index}`,
			tokenEstimate: 1,
			protected: false,
			contentBlocks: [],
			message: assistantMessage(`tiny ${index}`),
			toolCallIds: [],
		})),
	];
	return {
		entries,
		protectedEntryIds: ["entry-user"],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: createTranscript().settings,
	};
}

function criticalRecentBoundaryTranscript(): CompactableTranscript {
	const task: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "Protected task anchor." }],
		timestamp: Date.now(),
	};
	const entries: CompactableTranscript["entries"] = [
		{
			entryId: "task",
			entryType: "message",
			role: "user",
			text: "Protected task anchor.",
			tokenEstimate: 10,
			protected: true,
			contentBlocks: [],
			message: task,
			toolCallIds: [],
		},
		{
			entryId: "old-equivalent",
			entryType: "message",
			role: "assistant",
			text: "Old equivalent assistant context.",
			tokenEstimate: 50,
			protected: false,
			contentBlocks: [],
			message: assistantMessage("Old equivalent assistant context."),
			toolCallIds: [],
		},
		{
			entryId: "recent-unprotected",
			entryType: "message",
			role: "assistant",
			text: "Recent unprotected assistant context.",
			tokenEstimate: 50,
			protected: false,
			contentBlocks: [],
			message: assistantMessage("Recent unprotected assistant context."),
			toolCallIds: [],
		},
		...Array.from({ length: 4 }, (_, index) => ({
			entryId: `recent-tail-${index}`,
			entryType: "message" as const,
			role: "assistant" as const,
			text: `recent tail ${index}`,
			tokenEstimate: 5,
			protected: false,
			contentBlocks: [],
			message: assistantMessage(`recent tail ${index}`),
			toolCallIds: [],
		})),
	];
	return {
		entries,
		protectedEntryIds: ["task"],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: createTranscript().settings,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "critical-boundary" },
	};
}

describe("context compaction tiered fallback ladder", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("accepts a below-target tier-2 result when projected tokens fit the overflow budget", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-old-1" }] })),
			...repeatedTextStops(),
		]);

		const result = await contextCompact(preparation(createTranscript()), faux.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 32,
			criticalEvictionTokenBudget: 32,
		});

		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "entry-old-1" }]);
		expect(result.stats.percentReduction).toBeLessThan(50);
		expect(faux.state.callCount).toBe(3);
	});

	it("accepts a below-target tier-2 result on the threshold path when projected tokens fit the trigger boundary", async () => {
		const contexts: Context[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage(fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-old-1" }] }));
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("Stopping below strict target but inside threshold boundary.");
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("Still below strict target.");
			},
		]);

		const result = await contextCompact(preparation(createTranscript()), faux.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 32,
		});

		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "entry-old-1" }]);
		expect(result.stats.percentReduction).toBeLessThan(50);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(32);
		expect(faux.state.callCount).toBe(3);
		expect(contexts.map((context) => JSON.stringify(context)).join("\n")).not.toContain("<critical-overflow-mode>");
	});

	it("does not escalate threshold compaction to critical overflow when tier-2 misses budget", async () => {
		const contexts: Context[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage(fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-old-1" }] }));
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("Stopping below budget.");
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("Stopping below budget again.");
			},
		]);

		await expect(
			contextCompact(preparation(createTranscript()), faux.getModel(), "test-key", undefined, undefined, "off", {
				acceptanceTokenBudget: 20,
			}),
		).rejects.toThrow(/did not meet the strict 50% reduction requirement/);
		expect(contexts.map((context) => JSON.stringify(context)).join("\n")).not.toContain("<critical-overflow-mode>");
	});

	it("runs a critical overflow planner pass that can delete a stale protected task-bearing entry", async () => {
		const contexts: Context[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage(fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-assistant-0" }] }));
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("standard miss");
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("standard miss again");
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage(fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-old-user" }] }));
			},
		]);

		const result = await contextCompact(preparation(createProtectedTranscript()), faux.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 24,
			criticalEvictionTokenBudget: 24,
		});

		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "entry-old-user" },
			{ kind: "entry", entryId: "entry-assistant-0" },
		]);
		expectProtectedIdsDisjointFromDeleted(result);
		const criticalPrompt = (contexts[3] as { messages: Array<{ content: Array<{ text?: string }> }> }).messages[0]!.content[0]!.text ?? "";
		expect(criticalPrompt).toContain("<critical-overflow-mode>");
		expect(criticalPrompt).toContain('"entryId": "entry-old-user"');
		expect(criticalPrompt).toContain('"protected": false');
	});

	it("critical planner rejects unprotected entries inside the last-5 floor but can delete older equivalents", async () => {
		const contexts: Context[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("standard miss");
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("standard miss again");
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage(fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "recent-unprotected" }] }));
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage(fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "old-equivalent" }] }));
			},
		]);

		const result = await contextCompact(preparation(criticalRecentBoundaryTranscript()), faux.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 40,
			criticalEvictionTokenBudget: 80,
		});

		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "old-equivalent" }]);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(80);
		expectProtectedIdsDisjointFromDeleted(result);
		expect(contexts.map((context) => JSON.stringify(context)).join("\n")).toContain("recent context");
	});

	it("falls back to deterministic tier-4 eviction and reports terminal exhaustion", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("provider failed", { stopReason: "error", errorMessage: "provider unavailable" })]);

		const result = await contextCompact(preparation(createProtectedTranscript()), faux.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 28,
			criticalEvictionTokenBudget: 28,
		});
		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "entry-old-user" }]);
		expectProtectedIdsDisjointFromDeleted(result);

		const failing = registerFauxProvider();
		cleanups.push(() => failing.unregister());
		failing.setResponses([
			fauxAssistantMessage("standard miss"),
			fauxAssistantMessage("standard miss again"),
			fauxAssistantMessage("critical miss"),
			fauxAssistantMessage("critical miss again"),
		]);
		await expect(
			contextCompact(preparation(createTranscript()), failing.getModel(), "test-key", undefined, undefined, "off", {
				acceptanceTokenBudget: 0,
				criticalEvictionTokenBudget: 0,
			}),
		).rejects.toThrow(/attempt reached 0%.*nothing more was safely deletable/s);
	});

	it("accepts provider-overflow salvage when partial validated deletions fit the acceptance budget", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-old-1" }] })),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 100 tokens > 10 maximum",
			}),
		]);

		const result = await contextCompact(preparation(createTranscript()), faux.getModel(), "test-key", undefined, undefined, "off", {
			acceptanceTokenBudget: 32,
			criticalEvictionTokenBudget: 32,
		});

		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "entry-old-1" }]);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(32);
	});

	it("caps planner nudges at CONTEXT_COMPACTION_MAX_PLANNER_NUDGES", async () => {
		const contexts: Context[] = [];
		let deletionIndex = 0;
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const responses = Array.from({ length: 120 }, () => (context: Context) => {
			contexts.push(context);
			if (deletionIndex < 60 && contexts.length % 2 === 1) {
				const response = fauxAssistantMessage(
					fauxToolCall("context_delete", {
						deletions: [{ kind: "entry", entryId: `entry-old-${deletionIndex}` }],
					}),
				);
				deletionIndex += 1;
				return response;
			}
			return fauxAssistantMessage("done before strict target");
		});
		faux.setResponses(responses);

		await expect(contextCompact(preparation(manyTinyTranscript()), faux.getModel(), "test-key")).rejects.toThrow(
			/did not meet the strict 50% reduction requirement/,
		);
		const finalContext = contexts.at(-1) as { messages?: Array<{ role: string; content: Array<{ text?: string }> }> } | undefined;
		const nudgeMessages = finalContext?.messages?.filter((message) =>
			message.content.some((content) =>
				content.text?.includes("strict 50% context-reduction requirement is not met yet"),
			),
		) ?? [];
		expect(CONTEXT_COMPACTION_MAX_PLANNER_NUDGES).toBe(50);
		expect(nudgeMessages.length).toBeLessThanOrEqual(CONTEXT_COMPACTION_MAX_PLANNER_NUDGES);
	});
});
