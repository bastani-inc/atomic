import type { ContextDeletionTarget } from "../session-manager.ts";
import type { CompactableTranscript } from "./context-compaction-types.ts";
import type { ContextGrepDeletionMatch, ContextGrepDeletionSkipped } from "./context-deletion-tool-definitions.ts";
import {
	CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS,
	CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS,
} from "./context-deletion-tool-definitions.ts";
import { formatErrorMessage } from "./context-compaction-metrics.ts";
import { validateContextDeletionRequest } from "./context-deletion-application.ts";
import {
	deletionRequestFromTargets,
	findLatestAssistantThinkingDeletionViolation,
	getDeletedContentBlocks,
	getDeletedEntryIds,
	isProtectedContextDeletionErrorMessage,
	mergeContextDeletionTargets,
	targetKey,
} from "./context-deletion-targets.ts";

export function escapeRegExpLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function assertSafeRegexPattern(pattern: string): void {
	if (pattern.length > CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS) {
		throw new Error(
			`Regex pattern is too long (${pattern.length} characters); maximum is ${CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS}`,
		);
	}

	// Heuristic ReDoS guard for common catastrophic-backtracking shapes. JavaScript's RegExp engine
	// does not expose a timeout, so reject nested quantified groups and backreferences instead of
	// relying only on transcript scan-size caps.
	const hasNestedQuantifiedGroup = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/u.test(pattern);
	const hasQuantifiedAlternation = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/u.test(pattern);
	const hasBackreference = /\\[1-9]/u.test(pattern);
	if (hasNestedQuantifiedGroup || hasQuantifiedAlternation || hasBackreference) {
		throw new Error(
			"Regex pattern is not allowed because it may cause excessive backtracking; use a literal pattern or exact deletion targets instead.",
		);
	}
}

export function createGrepMatcher(pattern: string, regex: boolean, caseSensitive: boolean): RegExp {
	if (regex) {
		assertSafeRegexPattern(pattern);
	}

	try {
		return new RegExp(regex ? pattern : escapeRegExpLiteral(pattern), caseSensitive ? "u" : "iu");
	} catch (error) {
		throw new Error(`Invalid grep ${regex ? "regex" : "pattern"}: ${formatErrorMessage(error)}`);
	}
}

export function assertSafeRegexScan(scanChars: number): void {
	if (scanChars <= CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS) return;
	throw new Error(
		`Regex grep would scan ${scanChars} characters; maximum is ${CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS}. Use a literal pattern or exact deletion targets instead.`,
	);
}

export function clampInteger(value: number | undefined, defaultValue: number, minimum: number, maximum: number): number {
	if (value === undefined) return defaultValue;
	return Math.max(minimum, Math.min(maximum, value));
}

export function textSlice(text: string, offset: number, maxChars: number): string {
	return text.slice(offset, Math.min(text.length, offset + maxChars));
}

export function findMatchIndex(matcher: RegExp, text: string): number {
	const match = matcher.exec(text);
	matcher.lastIndex = 0;
	return match?.index ?? -1;
}

export function snippetForMatch(text: string, matchIndex: number, contextChars: number): string {
	const start = Math.max(0, matchIndex - contextChars);
	const end = Math.min(text.length, matchIndex + contextChars);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${text.slice(start, end)}${suffix}`;
}

export function currentTargetDeleted(targets: readonly ContextDeletionTarget[], target: ContextDeletionTarget): boolean {
	const deletedEntryIds = getDeletedEntryIds(targets);
	if (deletedEntryIds.has(target.entryId)) return true;
	if (target.kind === "entry") return false;
	return getDeletedContentBlocks(targets).get(target.entryId)?.has(target.blockIndex) === true;
}

export function addGrepCandidate(
	candidates: ContextDeletionTarget[],
	matches: ContextGrepDeletionMatch[],
	seenTargets: Set<string>,
	candidate: ContextDeletionTarget,
	match: ContextGrepDeletionMatch,
): void {
	const key = targetKey(candidate);
	if (seenTargets.has(key)) return;
	seenTargets.add(key);
	candidates.push(candidate);
	matches.push(match);
}

export function pushProtectedGrepSkip(skipped: ContextGrepDeletionSkipped[], match: ContextGrepDeletionMatch): void {
	skipped.push({
		entryId: match.entryId,
		target: match.target,
		...(match.blockIndex === undefined ? {} : { blockIndex: match.blockIndex }),
		reason: match.target === "content_block" ? "protected_block" : "protected_entry",
		text: match.text,
	});
}

export function filterProtectedGrepCandidates(
	candidates: readonly ContextDeletionTarget[],
	matches: readonly ContextGrepDeletionMatch[],
	currentTargets: readonly ContextDeletionTarget[],
	transcript: CompactableTranscript,
	skipped: ContextGrepDeletionSkipped[],
): { candidates: ContextDeletionTarget[]; matches: ContextGrepDeletionMatch[] } {
	const eligibleCandidates: ContextDeletionTarget[] = [];
	const eligibleMatches: ContextGrepDeletionMatch[] = [];
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		const match = matches[index];
		if (!candidate || !match) continue;
		try {
			const mergedTargets = mergeContextDeletionTargets(currentTargets, [candidate]);
			validateContextDeletionRequest(deletionRequestFromTargets(mergedTargets), transcript);
			eligibleCandidates.push(candidate);
			eligibleMatches.push(match);
		} catch (error) {
			const message = formatErrorMessage(error);
			if (isProtectedContextDeletionErrorMessage(message)) {
				pushProtectedGrepSkip(skipped, match);
				continue;
			}
			eligibleCandidates.push(candidate);
			eligibleMatches.push(match);
		}
	}

	// Some latest-assistant thinking violations only become visible after a grep batch also
	// deletes newer assistant entries. Classify the newly-unsafe grep candidates as
	// protected/skipped before maxMatches, expectedMatchCount, stats, or removals are computed.
	let changed = true;
	while (changed) {
		changed = false;
		const mergedTargets = mergeContextDeletionTargets(currentTargets, eligibleCandidates);
		const violation = findLatestAssistantThinkingDeletionViolation(transcript, mergedTargets);
		if (!violation) continue;
		const violationKey = targetKey(violation);
		let violationIndex = eligibleCandidates.findIndex((candidate) => targetKey(candidate) === violationKey);
		if (violationIndex < 0) {
			violationIndex = eligibleCandidates.findIndex((_candidate, candidateIndex) => {
				const remainingCandidates = eligibleCandidates.filter((_candidateToKeep, index) => index !== candidateIndex);
				const remainingTargets = mergeContextDeletionTargets(currentTargets, remainingCandidates);
				const remainingViolation = findLatestAssistantThinkingDeletionViolation(transcript, remainingTargets);
				return !remainingViolation || targetKey(remainingViolation) !== violationKey;
			});
		}
		if (violationIndex < 0) continue;
		const [skippedMatch] = eligibleMatches.splice(violationIndex, 1);
		eligibleCandidates.splice(violationIndex, 1);
		if (skippedMatch) pushProtectedGrepSkip(skipped, skippedMatch);
		changed = true;
	}

	return { candidates: eligibleCandidates, matches: eligibleMatches };
}
