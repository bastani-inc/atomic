import type { CuratorServerHandle } from "./curator-server.js";
import type { ExtractedContent } from "./extract.js";
import type { ResolvedSearchProvider } from "./gemini-search.js";
import type { QueryResultData } from "./storage.js";
import type { SummaryGenerationContext } from "./summary-review.js";
import type { GlimpseWindow } from "./web-search-browser.js";
import type { CuratorWorkflow, ProviderAvailability } from "./web-search-config.js";

export interface WebSearchToolUpdate {
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
}

export interface PendingCurate {
	phase: "searching" | "curating";
	workflow: CuratorWorkflow;
	summaryContext: SummaryGenerationContext;
	searchResults: Map<number, QueryResultData>;
	allInlineContent: ExtractedContent[];
	queryList: string[];
	includeContent: boolean;
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	availableProviders: ProviderAvailability;
	defaultProvider: ResolvedSearchProvider;
	summaryModels: Array<{ value: string; label: string }>;
	defaultSummaryModel: string | null;
	timeoutSeconds: number;
	onUpdate: ((update: WebSearchToolUpdate) => void) | undefined;
	signal: AbortSignal | undefined;
	abortSearches: () => void;
	finish: (value: unknown) => void;
	cancel: (reason?: "user" | "stale") => void;
	browserPromise?: Promise<void>;
}

export interface WebSearchRuntimeState {
	sessionActive: boolean;
	pendingCurate: PendingCurate | null;
	activeCurator: CuratorServerHandle | null;
	glimpseWin: GlimpseWindow | null;
}

export function cancelPendingCurate(
	state: WebSearchRuntimeState,
	reason: "user" | "stale" = "stale",
): void {
	state.pendingCurate?.cancel(reason);
}
