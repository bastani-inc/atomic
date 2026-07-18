import type { Message } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.js";
import { normalizeDerivedSessionEntries } from "../session-entry-normalization.js";
import { buildSessionContext } from "../session-manager-history.js";
import type { SessionEntry } from "../session-manager-types.js";
import {
	autoDetectCompactionQuery,
	latestActiveBoundary,
	setKeptTailTokenEstimate,
	visibleEntries,
} from "./compaction-boundary.js";
import { estimateContextTokens, type CompactionSettings } from "./compaction.js";
import { normalizeCompactionParameters } from "./compaction-parameters.js";
import { compactionQueryProvenance, setCompactionQueryProvenance } from "./compaction-query-provenance.js";
import {
	MIN_COMPACTABLE_REGION_LINES,
	VERBATIM_COMPACTION_FORMAT_FULL,
	type FullCollapsePreparation,
	type NumberedRegion,
	type VerbatimCompactionParameters,
} from "./compaction-types.js";
import { createNumberedRegion, serializeConversationForCompaction } from "./transcript-serialization.js";

interface ProtectedTail {
	lineNumbers: ReadonlySet<number>;
	count: number;
}

/**
 * Map the trailing `preserve_recent` normalized provider-visible messages to
 * their physical line suffix. The complete sequence has already undergone
 * orphan repair; slicing this canonical sequence must not repair the tail again.
 */
function mapProtectedRecentLines(messages: Message[], regionText: string, n: number): ProtectedTail {
	if (n <= 0 || messages.length === 0) return { lineNumbers: new Set(), count: 0 };
	const count = Math.min(n, messages.length);
	const tailText = serializeConversationForCompaction(messages.slice(messages.length - count));
	if (tailText.length === 0 || !regionText.endsWith(tailText)) return { lineNumbers: new Set(), count: 0 };
	const totalLines = regionText.split("\n").length;
	const tailLines = tailText.split("\n").length;
	const start = Math.max(1, totalLines - tailLines + 1);
	const set = new Set<number>();
	for (let line = start; line <= totalLines; line++) set.add(line);
	return { lineNumbers: set, count };
}

/** True when every non-blank source line is protected (nothing useful remains to delete). */
function allLinesProtected(region: NumberedRegion): boolean {
	const protectedLines = region.protectedLineNumbers ?? new Set<number>();
	for (let line = 1; line <= region.lines.length; line++) {
		if (protectedLines.has(line)) continue;
		if (region.lines[line - 1].trim().length > 0) return false;
	}
	return true;
}

/** First path index of the region to collapse, given the previous active boundary. */
function regionStartIndex(entries: SessionEntry[], previous: ReturnType<typeof latestActiveBoundary>): number {
	if (!previous) return 0;
	if (previous.entry.details?.format === VERBATIM_COMPACTION_FORMAT_FULL) return previous.index + 1;
	// Legacy hybrid previous boundary: its kept tail is still context-visible and
	// must be folded into the new region alongside the prior compacted string.
	const keptIndex = entries.findIndex((entry) => entry.id === previous.entry.firstKeptEntryId);
	return keptIndex >= 0 ? keptIndex : previous.index + 1;
}

/**
 * Prepare a v2 full-collapse boundary: serialize the entire current context
 * (prior compacted string + every context-visible message since it) with no
 * user-turn `selectCut` widening, and mark the trailing `preserve_recent`
 * messages as mandatory verbatim protected lines.
 *
 * Returns `undefined` only when the serialized region is below the minimum
 * compactable size or every non-blank line is protected (contract §8).
 */
export interface FullCollapsePreparationOptions extends Partial<VerbatimCompactionParameters> {
	excludedEntryIds?: ReadonlySet<string>;
	anchorId?: string;
}

export function prepareFullCollapseBoundary(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options: FullCollapsePreparationOptions = {},
): FullCollapsePreparation | undefined {
	const entries = normalizeDerivedSessionEntries(pathEntries).filter((entry) => !options.excludedEntryIds?.has(entry.id));
	const previous = latestActiveBoundary(entries);
	const visible = visibleEntries(entries, regionStartIndex(entries, previous));
	const { excludedEntryIds: _excludedEntryIds, anchorId: _anchorId, ...parameterOptions } = options;
	const parameterInput = { ...settings, ...parameterOptions };
	const parameters = normalizeCompactionParameters(parameterInput, autoDetectCompactionQuery(entries));

	const normalizedMessages = convertToLlm(visible.map((item) => item.message));
	const serialized = serializeConversationForCompaction(normalizedMessages);
	const regionText = previous?.entry.summary ? `${previous.entry.summary}\n${serialized}` : serialized;
	if (regionText.length === 0) return undefined;

	const preserved = mapProtectedRecentLines(normalizedMessages, regionText, parameters.preserve_recent);
	const region = createNumberedRegion(regionText, preserved.lineNumbers);
	if (region.lines.length < MIN_COMPACTABLE_REGION_LINES) return undefined;
	if (allLinesProtected(region)) return undefined;

	const anchorId = options.anchorId ?? entries[entries.length - 1]?.id;
	if (!anchorId) return undefined;

	const preparation: FullCollapsePreparation = {
		format: VERBATIM_COMPACTION_FORMAT_FULL,
		firstKeptEntryId: anchorId,
		region,
		regionEntryIds: visible.map((item) => item.entry.id),
		keptTailMessageCount: 0,
		protectedMessageCount: preserved.count,
		tokensBefore: estimateContextTokens(buildSessionContext(entries).messages).tokens,
		parameters,
		settings,
	};
	setKeptTailTokenEstimate(preparation, 0);
	setCompactionQueryProvenance(preparation, compactionQueryProvenance(parameterInput));
	return preparation;
}
