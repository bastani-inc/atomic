import type { ContextDeletionTarget } from "../session-manager.ts";
import type { CompactableTranscript } from "./context-compaction-types.ts";
import type { ContextGrepDeletionMatch, ContextGrepDeletionSkipped } from "./context-deletion-tool-definitions.ts";
import {
	CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS,
	CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS,
} from "./context-deletion-tool-definitions.ts";
import { formatErrorMessage } from "./context-compaction-metrics.ts";
import { reconcileToolDependencies, validateContextDeletionRequest } from "./context-deletion-application.ts";
import {
	deletionRequestFromTargets,
	getDeletedContentBlocks,
	getDeletedEntryIds,
	mergeContextDeletionTargets,
	targetKey,
} from "./context-deletion-targets.ts";
import {
	analyzeCompactableAssistantTurns,
	isTranscriptEntryEffectivelyDeleted,
	transcriptEntryStartsNewTurn,
} from "./context-assistant-turns.js";

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

function assistantTurnsForTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
) {
	const reconciled = reconcileToolDependencies(transcript, targets);
	return { reconciled, ...analyzeCompactableAssistantTurns(transcript, reconciled) };
}

function candidateRemovesBoundary(
	transcript: CompactableTranscript,
	currentTargets: readonly ContextDeletionTarget[],
	candidate: ContextDeletionTarget,
): boolean {
	const entry = transcript.entries.find((item) => item.entryId === candidate.entryId);
	if (!entry) return false;
	const beforeEntries = getDeletedEntryIds(currentTargets);
	const beforeBlocks = getDeletedContentBlocks(currentTargets);
	const before =
		!isTranscriptEntryEffectivelyDeleted(entry, beforeEntries, beforeBlocks) &&
		transcriptEntryStartsNewTurn(entry, beforeBlocks.get(entry.entryId));
	if (!before) return false;
	try {
		const after = assistantTurnsForTargets(transcript, mergeContextDeletionTargets(currentTargets, [candidate]));
		return isTranscriptEntryEffectivelyDeleted(entry, after.deletedEntryIds, after.deletedContentBlocks) ||
			!transcriptEntryStartsNewTurn(entry, after.deletedContentBlocks.get(entry.entryId));
	} catch {
		return true;
	}
}

interface SemanticCandidate {
	index: number;
	affectedTurns: Set<number>;
}
export function filterProtectedGrepCandidates(
	candidates: readonly ContextDeletionTarget[],
	matches: readonly ContextGrepDeletionMatch[],
	currentTargets: readonly ContextDeletionTarget[],
	transcript: CompactableTranscript,
	skipped: ContextGrepDeletionSkipped[],
): { candidates: ContextDeletionTarget[]; matches: ContextGrepDeletionMatch[] } {
	const rejected = new Set<number>();
	const accepted = new Set<number>();
	let acceptedTargets = [...currentTargets];
	const base = assistantTurnsForTargets(transcript, currentTargets);
	const signedTurnByEntryId = new Map<string, number>();
	base.turns.forEach((turn, turnIndex) => {
		for (const entryId of turn.signedThinkingEntryIds) signedTurnByEntryId.set(entryId, turnIndex);
	});
	const boundaries: number[] = [];
	const ordinary: number[] = [];
	const semantic: SemanticCandidate[] = [];

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index]!;
		if (candidateRemovesBoundary(transcript, currentTargets, candidate)) {
			boundaries.push(index);
			continue;
		}
		try {
			const single = assistantTurnsForTargets(
				transcript,
				mergeContextDeletionTargets(currentTargets, [candidate]),
			);
			const affectedTurns = new Set<number>();
			for (const entryId of single.deletedEntryIds) {
				if (base.deletedEntryIds.has(entryId)) continue;
				const turnIndex = signedTurnByEntryId.get(entryId);
				if (turnIndex !== undefined) affectedTurns.add(turnIndex);
			}
			if (affectedTurns.size === 0) ordinary.push(index);
			else semantic.push({ index, affectedTurns });
		} catch {
			rejected.add(index);
		}
	}

	const components: SemanticCandidate[][] = [];
	for (const item of semantic) {
		const overlapping = components.filter((component) =>
			component.some((member) => [...member.affectedTurns].some((turn) => item.affectedTurns.has(turn))),
		);
		if (overlapping.length === 0) {
			components.push([item]);
			continue;
		}
		const merged = [item, ...overlapping.flat()];
		for (const component of overlapping) components.splice(components.indexOf(component), 1);
		components.push(merged.sort((left, right) => left.index - right.index));
	}

	for (const component of components.sort((left, right) => left[0]!.index - right[0]!.index)) {
		const indexes = component.map((item) => item.index);
		const proposed = mergeContextDeletionTargets(acceptedTargets, indexes.map((index) => candidates[index]!));
		let complete = true;
		try {
			const effect = assistantTurnsForTargets(transcript, proposed);
			const affectedTurns = new Set(component.flatMap((item) => [...item.affectedTurns]));
			for (const turnIndex of affectedTurns) {
				const turn = base.turns[turnIndex]!;
				if (turn.active || !turn.signedThinkingEntryIds.every((entryId) => effect.deletedEntryIds.has(entryId))) {
					complete = false;
					break;
				}
			}
			if (complete) validateContextDeletionRequest(deletionRequestFromTargets(proposed), transcript);
		} catch {
			complete = false;
		}
		if (!complete) {
			for (const index of indexes) rejected.add(index);
			continue;
		}
		acceptedTargets = proposed;
		for (const index of indexes) accepted.add(index);
	}

	const acceptIndividually = (indexes: readonly number[]): void => {
		for (const index of indexes) {
			const proposed = mergeContextDeletionTargets(acceptedTargets, [candidates[index]!]);
			try {
				validateContextDeletionRequest(deletionRequestFromTargets(proposed), transcript);
				acceptedTargets = proposed;
				accepted.add(index);
			} catch {
				rejected.add(index);
			}
		}
	};
	acceptIndividually(ordinary);
	acceptIndividually(boundaries);

	for (let index = 0; index < matches.length; index++) {
		if (rejected.has(index)) pushProtectedGrepSkip(skipped, matches[index]!);
	}
	return {
		candidates: candidates.filter((_candidate, index) => accepted.has(index)),
		matches: matches.filter((_match, index) => accepted.has(index)),
	};
}
