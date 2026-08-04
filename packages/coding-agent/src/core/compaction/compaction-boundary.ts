import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCustomMessage,
	messageIsLlmVisible,
	messageStartsLlmUserTurn,
} from "../messages.ts";
import { normalizeDerivedSessionEntries } from "../session-entry-normalization.ts";
import { buildSessionContext } from "../session-manager-history.ts";
import type { CompactionEntry, SessionEntry } from "../session-manager-types.ts";
import { type CompactionSettings, estimateContextTokens, estimateTokens } from "./compaction.ts";
import {
	COMPACTION_AUTO_QUERY,
	normalizeCompactionParameters,
	normalizeCompactionQuery,
} from "./compaction-parameters.js";
import {
	MIN_COMPACTABLE_REGION_LINES,
	VERBATIM_COMPACTION_STRATEGY,
	type VerbatimCompactionDetails,
	type VerbatimCompactionParameters,
	type VerbatimCompactionPreparation,
} from "./compaction-types.js";
import { createNumberedRegion, serializeConversationForCompaction } from "./transcript-serialization.js";

interface VisibleEntry {
	entry: SessionEntry;
	index: number;
	message: AgentMessage;
}

const keptTailTokensByPreparation = new WeakMap<VerbatimCompactionPreparation, number>();

/** Return the independently estimated cost of the protected tail. */
export function getKeptTailTokenEstimate(preparation: VerbatimCompactionPreparation): number {
	return (
		keptTailTokensByPreparation.get(preparation) ??
		Math.max(0, preparation.tokensBefore - preparation.region.tokenEstimate)
	);
}

function messageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.excludeFromContext,
		);
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

function activeBoundary(entry: SessionEntry): entry is CompactionEntry<VerbatimCompactionDetails> {
	if (entry.type !== "compaction") return false;
	const details = (entry as CompactionEntry<{ strategy?: string }>).details;
	return details?.strategy === VERBATIM_COMPACTION_STRATEGY;
}

function visibleEntries(entries: SessionEntry[], start = 0): VisibleEntry[] {
	const visible: VisibleEntry[] = [];
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index];
		const message = messageFromEntry(entry);
		if (message && messageIsLlmVisible(message)) visible.push({ entry, index, message });
	}
	return visible;
}

function messageText(message: AgentMessage): string {
	const converted = convertToLlm([message]);
	if (converted.length === 0) return "";
	return converted
		.flatMap((item) =>
			typeof item.content === "string"
				? [item.content]
				: item.content.filter((block) => block.type === "text").map((block) => block.text),
		)
		.join("\n");
}

export function autoDetectCompactionQuery(entries: readonly SessionEntry[]): string {
	const normalized = normalizeDerivedSessionEntries(entries);
	for (let index = normalized.length - 1; index >= 0; index--) {
		const message = messageFromEntry(normalized[index]);
		if (!message || !messageStartsLlmUserTurn(message)) continue;
		const text = messageText(message).trim();
		if (text) return normalizeCompactionQuery(text, COMPACTION_AUTO_QUERY);
	}
	return COMPACTION_AUTO_QUERY;
}

function latestActiveBoundary(
	entries: SessionEntry[],
): { entry: CompactionEntry<VerbatimCompactionDetails>; index: number } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (activeBoundary(entry)) return { entry, index };
	}
	return undefined;
}

/**
 * Planner eligibility, kept separate from boundary preparation.
 *
 * `MIN_COMPACTABLE_REGION_LINES` exists to stop repeated pointless *planned*
 * compaction. A load-bearing caller has a different problem: one oversized tool
 * result can blow the context window while producing fewer than 20 compactable
 * lines, and refusing to prepare a boundary there makes the "always completes"
 * guarantee hollow — the fresh rung and its tail-drop rule become unreachable.
 */
export interface CompactionBoundaryControl {
	/**
	 * Prepare a boundary even when the region is below the planner minimum.
	 * Only `load_bearing` callers set this; the runner routes such a region
	 * straight to the fresh rung without invoking a planner.
	 */
	allowSmallRegion?: boolean;
}

/** Prepare the complete compactable transcript and its exact context-visible message tail. */
export function prepareCompactionBoundary(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options: Partial<VerbatimCompactionParameters> = {},
	control: CompactionBoundaryControl = {},
): VerbatimCompactionPreparation | undefined {
	const entries = normalizeDerivedSessionEntries(pathEntries);
	const previous = latestActiveBoundary(entries);
	let regionStart = 0;
	if (previous) {
		const keptIndex =
			previous.entry.firstKeptEntryId === null
				? -1
				: entries.findIndex((entry) => entry.id === previous.entry.firstKeptEntryId);
		regionStart = keptIndex >= 0 ? keptIndex : previous.index + 1;
	}

	const visible = visibleEntries(entries, regionStart);
	const parameters = normalizeCompactionParameters({ ...settings, ...options }, autoDetectCompactionQuery(entries));
	const tailStart = Math.max(0, visible.length - parameters.preserve_recent);
	const regionMessages = visible.slice(0, tailStart);
	const tailMessages = visible.slice(tailStart);

	const serialized = serializeConversationForCompaction(convertToLlm(regionMessages.map((item) => item.message)));
	const regionText = [previous?.entry.summary, serialized]
		.filter((text): text is string => typeof text === "string" && text.length > 0)
		.join("\n");
	const region = createNumberedRegion(regionText);
	if (!control.allowSmallRegion && region.lines.length < MIN_COMPACTABLE_REGION_LINES) return undefined;

	const preparation: VerbatimCompactionPreparation = {
		firstKeptEntryId: tailMessages[0]?.entry.id ?? null,
		region,
		regionEntryIds: regionMessages.map((item) => item.entry.id),
		keptTailMessageCount: tailMessages.length,
		tokensBefore: estimateContextTokens(buildSessionContext(entries).messages).tokens,
		parameters,
		settings,
	};
	keptTailTokensByPreparation.set(
		preparation,
		tailMessages.reduce((sum, item) => sum + estimateTokens(item.message), 0),
	);
	return preparation;
}
