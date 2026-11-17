import type {
	SessionEntriesPage,
	SessionEntriesQuery,
	SessionEntryAt,
	SessionSearchCoverage,
	SessionSearchExtendOptions,
	SessionSearchIndex,
	SessionSearchText,
	SessionStore,
} from "../../src/core/storage/index.js";

export const readHistoryEntries = (
	store: SessionStore,
	id: string,
	query: SessionEntriesQuery,
): Promise<SessionEntriesPage> => store.readEntryRange!(id, query);

export const renderedSearchText = (entry: SessionEntryAt): SessionSearchText => ({ seq: entry.seq, text: "" });

export const extendHistoryIndex = (
	index: SessionSearchIndex,
	id: string,
	coverage: SessionSearchCoverage,
	texts: readonly SessionSearchText[],
	options: SessionSearchExtendOptions,
): Promise<boolean> => index.extend(id, 2, coverage.indexedSeq, coverage.lastSeq, texts, options);
