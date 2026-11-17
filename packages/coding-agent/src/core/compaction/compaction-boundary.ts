import type { AgentMessage } from "@bastani/atomic-agent-core";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCustomMessage,
	messageIsLlmVisible,
	messageStartsLlmUserTurn,
} from "../messages.ts";
import { normalizeDerivedSessionEntries } from "../session-entry-normalization.ts";
import { applyContextEdit, buildSessionProjection, collectContextEdits } from "../session-manager-history.ts";
import type { CompactionEntry, ContextEditEntry, SessionEntry } from "../session-manager-types.ts";
import { type CompactionSettings, estimateProjectedContextTokens } from "./compaction.ts";
import {
	THINKING_FREE_PROMPT_VERSION,
	VERBATIM_COMPACTION_STRATEGY,
	type VerbatimCompactionDetails,
	type VerbatimCompactionParameters,
	type VerbatimCompactionPreparation,
} from "./compaction-types.js";
import { createConversationRegion, omitLegacyThinkingSections } from "./transcript-serialization.js";

/** The query used when no user request is found: compaction is focused on the latest request. */
export const COMPACTION_AUTO_QUERY = "the latest user request";

interface VisibleEntry {
	entry: SessionEntry;
	message: AgentMessage;
}

function messageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	// Prompt state is replayed separately at the boundary.
	if (entry.type === "message") return entry.message.role === "system" ? undefined : entry.message;
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

/** Context-visible entries from `start`, with append-only context edits applied to their content. */
function visibleEntries(entries: SessionEntry[], start: number, edits: Map<string, ContextEditEntry>): VisibleEntry[] {
	const visible: VisibleEntry[] = [];
	for (let index = start; index < entries.length; index++) {
		const entry = entries[index];
		const raw = messageFromEntry(entry);
		if (!raw) continue;
		const edit = edits.get(entry.id);
		const message = edit ? applyContextEdit([raw], edit)[0] : raw;
		if (message && messageIsLlmVisible(message)) visible.push({ entry, message });
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

/** The text of the latest user request on the path, or {@link COMPACTION_AUTO_QUERY} when there is none. */
export function autoDetectCompactionQuery(entries: readonly SessionEntry[]): string {
	const normalized = normalizeDerivedSessionEntries(entries);
	for (let index = normalized.length - 1; index >= 0; index--) {
		const message = messageFromEntry(normalized[index]);
		if (!message || !messageStartsLlmUserTurn(message)) continue;
		const text = messageText(message).trim();
		if (text) return text;
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
 * The previous boundary's durable text in the current transcript grammar. Boundaries written before
 * `THINKING_FREE_PROMPT_VERSION` serialized thinking as `[Assistant thinking]: ` sections, which are dropped.
 */
function previousSummaryText(boundary: CompactionEntry<VerbatimCompactionDetails>): string {
	const { promptVersion } = boundary.details as { promptVersion?: number };
	return (promptVersion ?? 0) >= THINKING_FREE_PROMPT_VERSION
		? boundary.summary
		: omitLegacyThinkingSections(boundary.summary);
}

/** Index in `entries` of the first entry the previous boundary does not cover. */
function regionStartAfter(
	entries: readonly SessionEntry[],
	previous: CompactionEntry<VerbatimCompactionDetails> | undefined,
): number {
	if (!previous) return 0;
	const keptIndex =
		previous.firstKeptEntryId === null ? -1 : entries.findIndex((entry) => entry.id === previous.firstKeptEntryId);
	if (keptIndex >= 0) return keptIndex;
	const coveredIndex =
		previous.coveredThroughEntryId === undefined
			? -1
			: entries.findIndex((entry) => entry.id === previous.coveredThroughEntryId);
	if (coveredIndex >= 0) return coveredIndex + 1;
	const boundaryIndex = entries.findIndex((entry) => entry.id === previous.id);
	// A boundary written after every entry of `entries` covers all of them.
	return boundaryIndex >= 0 ? boundaryIndex + 1 : entries.length;
}

/**
 * Describe the context a boundary would replace: everything context-visible since the previous boundary, serialized
 * for extension hooks. Returns undefined when nothing new is in context since that boundary, so a context that was
 * just cleared is never cleared again.
 *
 * `pathEntries` ends where the new boundary may cut, which is before a turn that still waits on a tool result. The
 * previous boundary is looked up on `branch`, the whole branch, because it may have been written after that turn.
 */
export function prepareCompactionBoundary(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options: Partial<VerbatimCompactionParameters> = {},
	branch: readonly SessionEntry[] = pathEntries,
): VerbatimCompactionPreparation | undefined {
	const entries = normalizeDerivedSessionEntries(pathEntries);
	const previous = latestActiveBoundary(normalizeDerivedSessionEntries([...branch]));
	const regionStart = regionStartAfter(entries, previous?.entry);
	const visible = visibleEntries(entries, regionStart, collectContextEdits(entries));
	if (visible.length === 0) return undefined;
	const query = options.query?.trim() || autoDetectCompactionQuery(entries);
	return {
		firstKeptEntryId: null,
		region: createConversationRegion(
			convertToLlm(visible.map((item) => item.message)),
			previous ? previousSummaryText(previous.entry) : undefined,
		),
		regionEntryIds: visible.map((item) => item.entry.id),
		keptTailMessageCount: 0,
		tokensBefore: estimateProjectedContextTokens(buildSessionProjection(entries), entries).tokens,
		parameters: { query },
		settings,
	};
}
