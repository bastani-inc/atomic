import { describe, expect, it } from "vitest";
import {
	resetIds,
	user,
	assistantText,
	assistantTextWithoutUsage,
	assistantTextWithTotalUsage,
	bashExecution,
	excludedBashExecution,
	excludedCustomAgentMessage,
	assistantToolCall,
	toolResult,
	toolResultWithImage,
	entry,
	customMessageEntry,
	contextEntry,
	compactionEntry,
	buildContextCompactionPrompt,
	CompactableTranscript,
	contextCompact,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	prepareContextCompaction,
	validateContextDeletionRequest,
	buildSessionContext,
	CompactionEntry,
	ContextCompactionEntry,
	CustomMessageEntry,
	getLatestCompactionBoundaryEntry,
	SessionEntry,
	SessionMessageEntry,
	fauxAssistantMessage,
	registerFauxProvider,
	AssistantMessage,
	ToolResultMessage,
} from "./context-compaction-helpers.js";

describe("context compaction", () => {
		it("adds Copilot long-context guidance to prompt-limit context compaction failures", async () => {
			resetIds();
			const rawError = "prompt token count of 500000 exceeds the limit of 400000";
			const task = entry(user("Retain the task."));
			const oldOne = entry(assistantText("Old search output that can be deleted."));
			const oldTwo = entry(assistantText("Old file read that can be deleted."));
			const recentOne = entry(assistantText("Recent operation one stays protected."));
			const recentTwo = entry(assistantText("Recent operation two stays protected."));
			const preparation = prepareContextCompaction(
				[task, oldOne, oldTwo, recentOne, recentTwo],
				DEFAULT_COMPACTION_SETTINGS,
			)!;
			const faux = registerFauxProvider({ provider: "github-copilot" });
			faux.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: rawError,
				}),
			]);
	
			try {
				await contextCompact(preparation, faux.getModel(), "test-key");
				throw new Error("Expected context compaction to fail");
			} catch (error) {
				if (!(error instanceof Error)) {
					throw error;
				}
				expect(error.message).toContain(rawError);
				expect(error.message).toContain("Copilot long-context/usage-based billing");
			} finally {
				faux.unregister();
			}
		});

		it("does not add Copilot guidance to non-Copilot prompt-limit context compaction failures", async () => {
			resetIds();
			const rawError = "prompt token count of 500000 exceeds the limit of 400000";
			const task = entry(user("Retain the task."));
			const oldOne = entry(assistantText("Old search output that can be deleted."));
			const oldTwo = entry(assistantText("Old file read that can be deleted."));
			const recentOne = entry(assistantText("Recent operation one stays protected."));
			const recentTwo = entry(assistantText("Recent operation two stays protected."));
			const preparation = prepareContextCompaction(
				[task, oldOne, oldTwo, recentOne, recentTwo],
				DEFAULT_COMPACTION_SETTINGS,
			)!;
			const faux = registerFauxProvider({ provider: "openai" });
			faux.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: rawError,
				}),
			]);
	
			try {
				await contextCompact(preparation, faux.getModel(), "test-key");
				throw new Error("Expected context compaction to fail");
			} catch (error) {
				if (!(error instanceof Error)) {
					throw error;
				}
				expect(error.message).not.toContain("Copilot long-context/usage-based billing");
			} finally {
				faux.unregister();
			}
		});

		it("excludes excludeFromContext entries from context compaction transcript, prompt, recency, and stats", () => {
			resetIds();
			const bashSentinel = "ITER4_EXCLUDED_BASH_SENTINEL";
			const customSentinel = "ITER4_EXCLUDED_CUSTOM_SENTINEL";
			const customEntrySentinel = "ITER4_EXCLUDED_CUSTOM_MESSAGE_ENTRY_SENTINEL";
			const sentinels = [bashSentinel, customSentinel, customEntrySentinel];
			const task = entry(user("Eligible user task remains protected"));
			const oldEligible = entry(assistantTextWithoutUsage("eligible old context can be deleted"));
			const recentCandidate = entry(assistantTextWithoutUsage("eligible recent candidate should remain protected"));
			const excludedBash = entry(excludedBashExecution(`echo ${bashSentinel}`, `output ${bashSentinel}`));
			const excludedCustom = entry(excludedCustomAgentMessage(customSentinel));
			const excludedCustomEntry = customMessageEntry(customEntrySentinel, true);
			const recent1 = entry(assistantTextWithoutUsage("eligible recent operation 1"));
			const recent2 = entry(assistantTextWithoutUsage("eligible recent operation 2"));
			const recent3 = entry(assistantTextWithoutUsage("eligible recent operation 3"));
			const recent4 = entry(assistantTextWithoutUsage("eligible recent operation 4"));
			const entries: SessionEntry[] = [
				task,
				oldEligible,
				recentCandidate,
				excludedBash,
				excludedCustom,
				excludedCustomEntry,
				recent1,
				recent2,
				recent3,
				recent4,
			];
	
			const rawContextMessages = buildSessionContext(entries).messages;
			const rawContextJson = JSON.stringify(rawContextMessages);
			for (const sentinel of sentinels) {
				expect(rawContextJson).toContain(sentinel);
			}
	
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
			expect(preparation).toBeDefined();
			const transcript = preparation!.transcript;
			const transcriptJson = JSON.stringify(transcript);
			const prompt = buildContextCompactionPrompt(transcript);
	
			for (const sentinel of sentinels) {
				expect(transcriptJson).not.toContain(sentinel);
				expect(prompt).not.toContain(sentinel);
			}
	
			const transcriptEntryIds = transcript.entries.map((item) => item.entryId);
			expect(transcriptEntryIds).not.toContain(excludedBash.id);
			expect(transcriptEntryIds).not.toContain(excludedCustom.id);
			expect(transcriptEntryIds).not.toContain(excludedCustomEntry.id);
			expect(transcript.protectedEntryIds).not.toContain(excludedBash.id);
			expect(transcript.protectedEntryIds).not.toContain(excludedCustom.id);
			expect(transcript.protectedEntryIds).not.toContain(excludedCustomEntry.id);
			expect(transcript.entries.find((item) => item.entryId === recentCandidate.id)?.protected).toBe(false);
			expect(transcript.entries.find((item) => item.entryId === recent3.id)?.protected).toBe(true);
			expect(transcript.entries.find((item) => item.entryId === recent4.id)?.protected).toBe(true);
	
			const eligibleContextMessages = rawContextMessages.filter((message) => {
				const serialized = JSON.stringify(message);
				return !sentinels.some((sentinel) => serialized.includes(sentinel));
			});
			expect(transcript.tokensBefore).toBe(estimateContextTokens(eligibleContextMessages).tokens);
			expect(transcript.tokensBefore).toBeLessThan(estimateContextTokens(rawContextMessages).tokens);
	
			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: oldEligible.id }] },
				transcript,
			);
			expect(validated.stats.objectsBefore).toBe(
				transcript.entries.length + transcript.entries.reduce((total, item) => total + item.contentBlocks.length, 0),
			);
			expect(validated.stats.objectsBefore).toBe(14);
			expect(validated.stats.objectsDeleted).toBe(2);
			expect(validated.stats.tokensBefore).toBe(transcript.tokensBefore);
			expect(validated.protectedEntryIds).not.toContain(excludedBash.id);
			expect(validated.protectedEntryIds).not.toContain(excludedCustom.id);
			expect(validated.protectedEntryIds).not.toContain(excludedCustomEntry.id);
		});

		it("auto-detects the compaction query from the last user message unless an explicit query is provided", () => {
			resetIds();
			const entries: SessionEntry[] = [
				entry(user("initial task query")),
				entry(assistantTextWithoutUsage("assistant progress")),
				entry(user("latest user focus query")),
				customMessageEntry("custom context after latest user"),
				entry(assistantTextWithoutUsage("recent assistant tail")),
			];
	
			const autoPreparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			expect(autoPreparation.parameters.query).toBe("latest user focus query");
	
			const explicitPreparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, {
				query: "explicit extension query",
			})!;
			expect(explicitPreparation.parameters.query).toBe("explicit extension query");
		});

		it("protects failed context-eligible bash executions while keeping excluded bash omitted", () => {
			resetIds();
			const excludedSentinel = "ITER5_EXCLUDED_FAILED_BASH_SENTINEL";
			const task = entry(user("Task that must remain available"));
			const failedBash = entry(bashExecution("bun test failing-suite", "expected failure output", 2));
			const excludedFailedBash = entry(
				bashExecution(`echo ${excludedSentinel}`, `hidden ${excludedSentinel}`, 1, true),
			);
			const oldDeletable = entry(assistantTextWithoutUsage("old assistant note can be deleted"));
			const recent1 = entry(assistantTextWithoutUsage("recent operation 1"));
			const recent2 = entry(assistantTextWithoutUsage("recent operation 2"));
			const recent3 = entry(assistantTextWithoutUsage("recent operation 3"));
			const recent4 = entry(assistantTextWithoutUsage("recent operation 4"));
			const recent5 = entry(assistantTextWithoutUsage("recent operation 5"));
			const entries: SessionEntry[] = [
				task,
				failedBash,
				excludedFailedBash,
				oldDeletable,
				recent1,
				recent2,
				recent3,
				recent4,
				recent5,
			];
	
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
			expect(preparation).toBeDefined();
			const transcript = preparation!.transcript;
			const transcriptJson = JSON.stringify(transcript);
			const failedTranscriptEntry = transcript.entries.find((item) => item.entryId === failedBash.id);
	
			expect(failedTranscriptEntry).toBeDefined();
			expect(failedTranscriptEntry!.protected).toBe(true);
			expect(transcript.protectedEntryIds).toContain(failedBash.id);
			expect(transcript.entries.map((item) => item.entryId)).not.toContain(excludedFailedBash.id);
			expect(transcript.protectedEntryIds).not.toContain(excludedFailedBash.id);
			expect(transcriptJson).not.toContain(excludedSentinel);
	
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: failedBash.id }] }, transcript),
			).toThrow(/protected/);
			expect(() =>
				validateContextDeletionRequest(
					{ deletions: [{ kind: "content_block", entryId: failedBash.id, blockIndex: 0 }] },
					transcript,
				),
			).toThrow(/protected/);
	
			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: oldDeletable.id }] },
				transcript,
			);
			expect(validated.deletedTargets).toEqual([{ kind: "entry", entryId: oldDeletable.id }]);
		});

		it("uses filtered token estimates instead of stale pre-boundary assistant usage for context stats", () => {
			resetIds();
			const task = entry(user("Task with post-boundary context"));
			const staleAssistantUsage = entry(assistantTextWithTotalUsage("pre-boundary assistant with stale usage", 1_000_000));
			const priorContextCompaction = contextEntry([]);
			const deletable = entry(assistantTextWithoutUsage("obsolete post-boundary note ".repeat(20)));
			const recent1 = entry(assistantTextWithoutUsage("recent post-boundary operation 1"));
			const recent2 = entry(assistantTextWithoutUsage("recent post-boundary operation 2"));
			const recent3 = entry(assistantTextWithoutUsage("recent post-boundary operation 3"));
			const recent4 = entry(assistantTextWithoutUsage("recent post-boundary operation 4"));
			const recent5 = entry(assistantTextWithoutUsage("recent post-boundary operation 5"));
			const recent6 = entry(assistantTextWithoutUsage("recent post-boundary operation 6"));
			const entries: SessionEntry[] = [
				task,
				staleAssistantUsage,
				priorContextCompaction,
				deletable,
				recent1,
				recent2,
				recent3,
				recent4,
				recent5,
				recent6,
			];
			const staleUsageEstimate = estimateContextTokens(buildSessionContext(entries).messages).tokens;
	
			expect(staleUsageEstimate).toBeGreaterThan(1_000_000);
	
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
			expect(preparation).toBeDefined();
			const transcript = preparation!.transcript;
			const transcriptEstimate = transcript.entries.reduce((total, item) => total + item.tokenEstimate, 0);
	
			expect(transcript.tokensBefore).toBe(transcriptEstimate);
			expect(transcript.tokensBefore).toBeLessThan(10_000);
			expect(transcript.tokensBefore).toBeLessThan(staleUsageEstimate);
	
			const deletableTranscriptEntry = transcript.entries.find((item) => item.entryId === deletable.id);
			expect(deletableTranscriptEntry).toBeDefined();
			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: deletable.id }] },
				transcript,
			);
			const expectedTokensAfter = Math.max(0, transcriptEstimate - deletableTranscriptEntry!.tokenEstimate);
			const expectedPercentReduction =
				transcriptEstimate > 0 ? Math.round(((transcriptEstimate - expectedTokensAfter) / transcriptEstimate) * 1000) / 10 : 0;
	
			expect(validated.stats.tokensBefore).toBe(transcriptEstimate);
			expect(validated.stats.tokensAfter).toBe(expectedTokensAfter);
			expect(validated.stats.percentReduction).toBe(expectedPercentReduction);
		});

		it("validates paired tool-call deletions and rebuilds without mutating retained entries", () => {
			resetIds();
			const u1 = entry(user("Original user task must stay verbatim"));
			const oldAssistant = entry(assistantText("old assistant note"));
			const call = entry(assistantToolCall("tool-1"));
			const result = entry(toolResult("tool-1", "redundant old file contents"));
			const oldAssistant2 = entry(assistantText("another old note"));
			const u2 = entry(user("Current instruction with active/path.ts:42"));
			const recent1 = entry(assistantText("recent operation 1"));
			const recent2 = entry(assistantText("recent operation 2"));
			const recent3 = entry(assistantText("recent operation 3"));
			const recent4 = entry(assistantText("recent operation 4"));
			const entries: SessionEntry[] = [u1, oldAssistant, call, result, oldAssistant2, u2, recent1, recent2, recent3, recent4];
	
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
			expect(preparation).toBeDefined();
			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: call.id }, { kind: "entry", entryId: result.id }] },
				preparation!.transcript,
			);
	
			expect(validated.deletedTargets).toEqual([
				{ kind: "entry", entryId: call.id },
				{ kind: "entry", entryId: result.id },
			]);
			expect(validated.stats.objectsDeleted).toBe(4);
			expect(validated.stats.objectsAfter).toBe(validated.stats.objectsBefore - 4);
	
			const compacted = contextEntry(validated.deletedTargets);
			const rebuilt = buildSessionContext([...entries, compacted]);
			expect(rebuilt.messages).not.toContain(call.message);
			expect(rebuilt.messages).not.toContain(result.message);
			expect(rebuilt.messages).toContain(u1.message);
			expect(rebuilt.messages).toContain(recent4.message);
			expect(rebuilt.messages).toContain(oldAssistant.message);
		});

		it("rejects protected user-message deletion", () => {
			resetIds();
			const u1 = entry(user("Do not delete user task"));
			const entries: SessionEntry[] = [
				u1,
				entry(assistantText("old 1")),
				entry(assistantText("old 2")),
				entry(assistantText("old 3")),
				entry(assistantText("old 4")),
				entry(assistantText("old 5")),
				entry(assistantText("old 6")),
			];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
	
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: u1.id }] }, preparation.transcript),
			).toThrow(/protected/);
		});
});
