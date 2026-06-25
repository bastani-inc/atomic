import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ContextCompactionStats, ContextDeletionTarget } from "../session-manager.ts";
import {
	CONTEXT_COMPACTION_AUTO_QUERY,
	type CompactableTranscript,
	type ContextCompactionRunOptions,
	type ValidatedContextDeletionResult,
} from "./context-compaction-types.ts";
import {
	createContextCompactionBudgetDetails,
	createContextDeletionToolResult,
	countRemainingImageBlocks,
	finitePositiveNumber,
	formatErrorMessage,
	sumRemainingImageTokens,
} from "./context-compaction-metrics.ts";
import { getTranscriptCompactionParameters, normalizeContextCompactionParameters } from "./context-compaction-strategy.ts";
import {
	CONTEXT_COMPACTION_BUDGET_TOOL,
	CONTEXT_DELETE_TOOL,
	CONTEXT_DELETE_TOOL_NAME,
	CONTEXT_GREP_DELETE_DEFAULT_MAX_MATCHES,
	CONTEXT_GREP_DELETE_TOOL,
	CONTEXT_GREP_DELETE_TOOL_NAME,
	CONTEXT_READ_ENTRY_DEFAULT_MAX_CHARS,
	CONTEXT_READ_ENTRY_MAX_CHARS,
	CONTEXT_READ_ENTRY_TOOL,
	CONTEXT_READ_ENTRY_TOOL_NAME,
	CONTEXT_SEARCH_DEFAULT_CONTEXT_CHARS,
	CONTEXT_SEARCH_DEFAULT_MAX_MATCHES,
	CONTEXT_SEARCH_MAX_CONTEXT_CHARS,
	CONTEXT_SEARCH_MAX_MATCHES,
	CONTEXT_SEARCH_TRANSCRIPT_TOOL,
	type ContextCompactionBudgetToolDetails,
	type ContextDeletionToolController,
	type ContextDeletionToolDetails,
	type ContextGrepDeletionMatch,
	type ContextGrepDeletionSkipped,
	type ContextGrepDeletionToolDetails,
	type ContextReadEntryToolDetails,
	type ContextTranscriptSearchMatch,
	type ContextTranscriptSearchToolDetails,
	ContextCompactionBudgetToolParameters,
	ContextDeleteToolParameters,
	ContextGrepDeleteToolParameters,
	ContextReadEntryToolParameters,
	ContextSearchTranscriptToolParameters,
} from "./context-deletion-tool-definitions.ts";
import { computeContextCompactionStats, contextDeletionRequestFromObject, validateContextDeletionRequest } from "./context-deletion-application.ts";
import {
	canDeleteTarget,
	deletionRequestFromTargets,
	getRecentContextEntryIds,
	isStaleUserImageOnlyEntry,
	mergeContextDeletionTargets,
} from "./context-deletion-targets.ts";
import { createContextDeletionStore } from "./context-deletion-store.ts";
import {
	addGrepCandidate,
	assertSafeRegexScan,
	clampInteger,
	createGrepMatcher,
	currentTargetDeleted,
	filterProtectedGrepCandidates,
	findMatchIndex,
	snippetForMatch,
	textSlice,
} from "./context-deletion-tool-helpers.ts";

export function createContextDeletionTool(
	inputTranscript: CompactableTranscript,
	options: ContextCompactionRunOptions = {},
): ContextDeletionToolController {
	const contextWindow = finitePositiveNumber(options.contextWindow);
	const parameters = normalizeContextCompactionParameters(
		{ ...getTranscriptCompactionParameters(inputTranscript), ...options },
		inputTranscript.parameters?.query ?? CONTEXT_COMPACTION_AUTO_QUERY,
	);
	const transcript: CompactableTranscript = { ...inputTranscript, parameters };
	const store = createContextDeletionStore(transcript);
	let validatedResult: ValidatedContextDeletionResult | undefined;

	function readTargets(): ContextDeletionTarget[] {
		return store.readTargets();
	}

	function applyValidatedTargets(additionalTargets: readonly ContextDeletionTarget[]): ValidatedContextDeletionResult {
		const mergedTargets = mergeContextDeletionTargets(readTargets(), additionalTargets);
		validatedResult = validateContextDeletionRequest(deletionRequestFromTargets(mergedTargets), transcript);
		store.replaceTargets(validatedResult.deletedTargets);
		return validatedResult;
	}

	function currentStats(): ContextCompactionStats {
		return validatedResult?.stats ?? computeContextCompactionStats(transcript, readTargets());
	}

	function canDeleteProtectedTarget(target: ContextDeletionTarget): boolean {
		return canDeleteTarget(transcript, target);
	}

	function shouldGrepDeleteContentBlockAsEntry(entryId: string, blockCount: number): boolean {
		if (blockCount <= 1) return true;
		const entry = transcript.entries.find((candidate) => candidate.entryId === entryId);
		return entry !== undefined && isStaleUserImageOnlyEntry(transcript, entry);
	}

	const tool: AgentTool<typeof ContextDeleteToolParameters, ContextDeletionToolDetails> = {
		...CONTEXT_DELETE_TOOL,
		label: "context deletion request",
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			return store.transaction(() => {
				const callCount = store.incrementCallCount();
				try {
					const incomingRequest = contextDeletionRequestFromObject(params, `${CONTEXT_DELETE_TOOL_NAME} arguments`);
					const incomingValidated = validateContextDeletionRequest(incomingRequest, transcript);
					const applied = applyValidatedTargets(incomingValidated.deletedTargets);
					store.clearLastError();
					const deletedTargets = readTargets();

					const details: ContextDeletionToolDetails = {
						deletions: deletionRequestFromTargets(deletedTargets).deletions,
						deletedTargets,
						stats: applied.stats,
						callCount,
					};
					const text = `Recorded ${incomingValidated.deletedTargets.length} deletion target(s); ${deletedTargets.length} total validated deletion target(s) are selected. Continue calling ${CONTEXT_DELETE_TOOL_NAME} or ${CONTEXT_GREP_DELETE_TOOL_NAME} for additional deletions, or respond done when finished.`;
					return createContextDeletionToolResult(text, details);
				} catch (error) {
					const message = formatErrorMessage(error);
					store.setLastError(message);
					const deletedTargets = readTargets();
					const details: ContextDeletionToolDetails = {
						deletions: deletionRequestFromTargets(deletedTargets).deletions,
						deletedTargets,
						stats: currentStats(),
						callCount,
						error: message,
					};
					return createContextDeletionToolResult(
						`Error recording context deletion targets: ${message}. No new deletion targets were applied; continue with a corrected tool call.`,
						details,
					);
				}
			});
		},
	};

	const grepTool: AgentTool<typeof ContextGrepDeleteToolParameters, ContextGrepDeletionToolDetails> = {
		...CONTEXT_GREP_DELETE_TOOL,
		label: "context grep delete",
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			return store.transaction(() => {
				const callCount = store.incrementCallCount();
				const pattern = params.pattern;
				const regex = params.regex === true;
				const caseSensitive = params.caseSensitive === true;
				const target = params.target ?? "entry";
				const maxMatches = params.maxMatches ?? CONTEXT_GREP_DELETE_DEFAULT_MAX_MATCHES;
				const candidates: ContextDeletionTarget[] = [];
				const matches: ContextGrepDeletionMatch[] = [];
				let reportedMatches: ContextGrepDeletionMatch[] = matches;
				const skipped: ContextGrepDeletionSkipped[] = [];
				const seenTargets = new Set<string>();

				try {
					if (regex) {
						assertSafeRegexScan(store.getGrepScanTextLength(target));
					}
					const matcher = createGrepMatcher(pattern, regex, caseSensitive);
					const currentTargets = readTargets();
					const recentEntryIds = getRecentContextEntryIds(transcript);

					if (target === "entry") {
						for (const entry of store.listEntriesForGrep()) {
							if (!matcher.test(entry.text)) continue;
							const candidate: ContextDeletionTarget = { kind: "entry", entryId: entry.entry_id };
							if (recentEntryIds.has(candidate.entryId)) {
								skipped.push({ entryId: entry.entry_id, target, reason: "protected_entry", text: entry.text });
								continue;
							}
							if (entry.is_protected === 1 && !canDeleteProtectedTarget(candidate)) {
								skipped.push({ entryId: entry.entry_id, target, reason: "protected_entry", text: entry.text });
								continue;
							}
							if (currentTargetDeleted(currentTargets, candidate)) {
								skipped.push({ entryId: entry.entry_id, target, reason: "already_deleted", text: entry.text });
								continue;
							}
							addGrepCandidate(candidates, matches, seenTargets, candidate, {
								entryId: entry.entry_id,
								target,
								text: entry.text,
							});
						}
					} else {
						for (const block of store.listContentBlocksForGrep()) {
							if (!matcher.test(block.text)) continue;
							const candidate: ContextDeletionTarget = shouldGrepDeleteContentBlockAsEntry(block.entry_id, block.block_count)
								? { kind: "entry", entryId: block.entry_id }
								: { kind: "content_block", entryId: block.entry_id, blockIndex: block.block_index };
							if (recentEntryIds.has(candidate.entryId)) {
								skipped.push({
									entryId: block.entry_id,
									target: candidate.kind,
									...(candidate.kind === "content_block" ? { blockIndex: candidate.blockIndex } : {}),
									reason: "protected_entry",
									text: block.text,
								});
								continue;
							}
							if (block.entry_protected === 1 && !canDeleteProtectedTarget(candidate)) {
								skipped.push({
									entryId: block.entry_id,
									target,
									blockIndex: block.block_index,
									reason: "protected_entry",
									text: block.text,
								});
								continue;
							}
							if (block.block_protected === 1 && !canDeleteProtectedTarget(candidate)) {
								skipped.push({
									entryId: block.entry_id,
									target,
									blockIndex: block.block_index,
									reason: "protected_block",
									text: block.text,
								});
								continue;
							}
							if (currentTargetDeleted(currentTargets, candidate)) {
								skipped.push({
									entryId: block.entry_id,
									target: candidate.kind,
									...(candidate.kind === "content_block" ? { blockIndex: candidate.blockIndex } : {}),
									reason: "already_deleted",
									text: block.text,
								});
								continue;
							}
							addGrepCandidate(candidates, matches, seenTargets, candidate, {
								entryId: block.entry_id,
								target: candidate.kind,
								...(candidate.kind === "content_block" ? { blockIndex: candidate.blockIndex } : {}),
								text: block.text,
							});
						}
					}

					const eligible = filterProtectedGrepCandidates(candidates, matches, currentTargets, transcript, skipped);
					reportedMatches = eligible.matches;
					let applied: ValidatedContextDeletionResult | undefined;
					if (params.expectedMatchCount !== undefined && eligible.candidates.length !== params.expectedMatchCount) {
						skipped.push({ reason: "expected_match_count_mismatch" });
					} else if (eligible.candidates.length > maxMatches) {
						skipped.push({ reason: "max_matches_exceeded" });
					} else if (eligible.candidates.length > 0) {
						applied = applyValidatedTargets(eligible.candidates);
					}
					store.clearLastError();
					const deletedTargets = readTargets();

					const details: ContextGrepDeletionToolDetails = {
						pattern,
						regex,
						caseSensitive,
						target,
						matches: eligible.matches,
						skipped,
						deletedTargets,
						stats: applied?.stats ?? currentStats(),
						callCount,
					};
					const text = `Matched ${eligible.matches.length} deletion target(s), skipped ${skipped.length}, and ${applied ? "applied" : "did not apply"} grep deletion for pattern ${JSON.stringify(pattern)}. Total validated deletion target(s): ${deletedTargets.length}.`;
					return createContextDeletionToolResult(text, details);
				} catch (error) {
					const message = formatErrorMessage(error);
					store.setLastError(message);
					const deletedTargets = readTargets();
					const details: ContextGrepDeletionToolDetails = {
						pattern,
						regex,
						caseSensitive,
						target,
						matches: reportedMatches,
						skipped,
						deletedTargets,
						stats: currentStats(),
						callCount,
						error: message,
					};
					return createContextDeletionToolResult(
						`Error applying grep deletion for pattern ${JSON.stringify(pattern)}: ${message}. No new deletion targets were applied; continue with a corrected tool call.`,
						details,
					);
				}
			});
		},
	};

	const searchTool: AgentTool<typeof ContextSearchTranscriptToolParameters, ContextTranscriptSearchToolDetails> = {
		...CONTEXT_SEARCH_TRANSCRIPT_TOOL,
		label: "context transcript search",
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			return store.transaction(() => {
				const callCount = store.incrementCallCount();
				const pattern = params.pattern;
				const regex = params.regex === true;
				const caseSensitive = params.caseSensitive === true;
				const target = params.target ?? "entry";
				const maxMatches = clampInteger(params.maxMatches, CONTEXT_SEARCH_DEFAULT_MAX_MATCHES, 1, CONTEXT_SEARCH_MAX_MATCHES);
				const contextChars = clampInteger(
					params.contextChars,
					CONTEXT_SEARCH_DEFAULT_CONTEXT_CHARS,
					0,
					CONTEXT_SEARCH_MAX_CONTEXT_CHARS,
				);
				const matches: ContextTranscriptSearchMatch[] = [];
				let truncated = false;

				try {
					if (regex) {
						assertSafeRegexScan(store.getGrepScanTextLength(target));
					}
					const matcher = createGrepMatcher(pattern, regex, caseSensitive);
					if (target === "entry") {
						for (const entry of store.listEntriesForGrep()) {
							const matchIndex = findMatchIndex(matcher, entry.text);
							if (matchIndex < 0) continue;
							if (matches.length >= maxMatches) {
								truncated = true;
								break;
							}
							matches.push({
								entryId: entry.entry_id,
								target,
								matchIndex,
								snippet: snippetForMatch(entry.text, matchIndex, contextChars),
								protected: entry.is_protected === 1,
							});
						}
					} else {
						for (const block of store.listContentBlocksForGrep()) {
							const matchIndex = findMatchIndex(matcher, block.text);
							if (matchIndex < 0) continue;
							if (matches.length >= maxMatches) {
								truncated = true;
								break;
							}
							matches.push({
								entryId: block.entry_id,
								target,
								blockIndex: block.block_index,
								matchIndex,
								snippet: snippetForMatch(block.text, matchIndex, contextChars),
								protected: block.entry_protected === 1 || block.block_protected === 1,
							});
						}
					}
					store.clearLastError();
					const details: ContextTranscriptSearchToolDetails = {
						pattern,
						regex,
						caseSensitive,
						target,
						matches,
						truncated,
						callCount,
					};
					const text = `Found ${matches.length}${truncated ? "+" : ""} ${target} match(es) for ${JSON.stringify(pattern)}. Use ${CONTEXT_READ_ENTRY_TOOL_NAME} with small maxChars to inspect exact content before deleting.`;
					return createContextDeletionToolResult(text, details);
				} catch (error) {
					const message = formatErrorMessage(error);
					store.setLastError(message);
					const details: ContextTranscriptSearchToolDetails = {
						pattern,
						regex,
						caseSensitive,
						target,
						matches,
						truncated,
						callCount,
						error: message,
					};
					return createContextDeletionToolResult(
						`Error searching transcript for ${JSON.stringify(pattern)}: ${message}. Try a literal pattern or narrower query.`,
						details,
					);
				}
			});
		},
	};

	const readEntryTool: AgentTool<typeof ContextReadEntryToolParameters, ContextReadEntryToolDetails> = {
		...CONTEXT_READ_ENTRY_TOOL,
		label: "context read entry",
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			return store.transaction(() => {
				const callCount = store.incrementCallCount();
				const offset = clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
				const maxChars = clampInteger(
					params.maxChars,
					CONTEXT_READ_ENTRY_DEFAULT_MAX_CHARS,
					1,
					CONTEXT_READ_ENTRY_MAX_CHARS,
				);
				try {
					const row =
						params.blockIndex === undefined
							? store.getEntryForRead(params.entryId)
							: store.getContentBlockForRead(params.entryId, params.blockIndex);
					if (!row) {
						throw new Error(
							params.blockIndex === undefined
								? `Unknown transcript entry: ${params.entryId}`
								: `Unknown transcript content block: ${params.entryId}:${params.blockIndex}`,
						);
					}
					const text = row.text;
					const slice = textSlice(text, offset, maxChars);
					store.clearLastError();
					const details: ContextReadEntryToolDetails = {
						entryId: params.entryId,
						...(params.blockIndex === undefined ? {} : { blockIndex: params.blockIndex }),
						offset,
						maxChars,
						totalChars: text.length,
						text: slice,
						truncatedBefore: offset > 0,
						truncatedAfter: offset + maxChars < text.length,
						callCount,
					};
					const textResult = `Read ${slice.length} of ${text.length} characters from ${params.blockIndex === undefined ? params.entryId : `${params.entryId}:${params.blockIndex}`}. Keep reads small; increase offset for the next slice if needed.`;
					return createContextDeletionToolResult(textResult, details);
				} catch (error) {
					const message = formatErrorMessage(error);
					store.setLastError(message);
					const details: ContextReadEntryToolDetails = {
						entryId: params.entryId,
						...(params.blockIndex === undefined ? {} : { blockIndex: params.blockIndex }),
						offset,
						maxChars,
						totalChars: 0,
						text: "",
						truncatedBefore: false,
						truncatedAfter: false,
						callCount,
						error: message,
					};
					return createContextDeletionToolResult(`Error reading transcript entry: ${message}`, details);
				}
			});
		},
	};

	const budgetTool: AgentTool<typeof ContextCompactionBudgetToolParameters, ContextCompactionBudgetToolDetails> = {
		...CONTEXT_COMPACTION_BUDGET_TOOL,
		label: "context compaction budget",
		executionMode: "parallel",
		async execute(_toolCallId) {
			return store.transaction(() => {
				const callCount = store.incrementCallCount();
				store.clearLastError();
				const liveTargets = readTargets(); // recompute image stats each call (issue #1500)
				const imageTokensRemaining = sumRemainingImageTokens(transcript, liveTargets);
				const imageBlocksRemaining = countRemainingImageBlocks(transcript, liveTargets);
				const details = createContextCompactionBudgetDetails(currentStats(), callCount, contextWindow, parameters, imageTokensRemaining, imageBlocksRemaining);
				const windowText =
					details.contextWindowBeforePercent !== undefined
						? ` Context window fullness: ${details.contextWindowBeforePercent}% before selected deletions, ${details.contextWindowAfterPercent}% after selected deletions.`
						: " Context window size is unknown for this model, so fullness percentages are unavailable.";
				const targetText = details.tokensToDeleteForTarget > 0 ? ` Delete about ${details.tokensToDeleteForTarget} more token(s) to reach the ${details.targetReductionPercent}% reduction target.` : ` The selected deletions meet or exceed the ${details.targetReductionPercent}% reduction target.`;
				const imageText = details.remainingImageTokens > 0 ? ` Images account for ${details.imageTokenPercent}% of remaining context (${details.remainingImageTokens} tokens across ${details.imageBlockCount} block(s)); prefer deleting stale/superseded image content blocks when images dominate.` : "";
				return createContextDeletionToolResult(
					`Current selected deletions reduce context by ${details.currentReductionPercent}% (${details.deletedTokens} token(s)); tokens after selected deletions: ${details.currentTokensAfter}/${details.tokensBefore}.${windowText}${targetText}${imageText} Keep maximizing useful retained context while aggressively removing low-value blocks.`,
					details,
				);
			});
		},
	};

	return {
		tool,
		grepTool,
		searchTool,
		readEntryTool,
		budgetTool,
		tools: [tool, grepTool, searchTool, readEntryTool, budgetTool],
		getDeletionRequest: () => deletionRequestFromTargets(readTargets()),
		getValidatedResult: () => validatedResult,
		getLastError: () => store.getLastError(),
		getCallCount: () => store.getCallCount(),
	};
}
