import { isStaleExtensionContextError, type ExtensionAPI, type ExtensionContext } from "@bastani/atomic";
import { fetchAllContent } from "./extract.js";
import { clearCloneCache } from "./github-extract.js";
import { registerContentTools } from "./content-tools.js";
import { clearResults, generateId, restoreFromSession, storeResult, type StoredSearchData } from "./storage.js";
import {
	createActivityWidgetState,
	refreshActivityForSession,
	shutdownActivityWidget,
	toggleActivityWidget,
} from "./web-search-activity.js";
import { openCuratorBrowser as openCuratorBrowserForSearch } from "./web-search-curator.js";
import { MAX_INLINE_CONTENT, formatFullResults, stripThumbnails } from "./web-search-formatting.js";
import { buildSearchReturn, type SearchReturnBuilder } from "./web-search-return.js";
import { cancelPendingCurate, type PendingCurate, type WebSearchRuntimeState } from "./web-search-types.js";
import { DEFAULT_SHORTCUTS, type WebSearchConfig } from "./web-search-config.js";
import { registerWebSearchCommand } from "./web-search-command.js";
import { registerWebSearchTool } from "./web-search-tool.js";

const pendingFetches = new Map<string, AbortController>();

const runtimeState: WebSearchRuntimeState = {
	sessionActive: false,
	pendingCurate: null,
	activeCurator: null,
	glimpseWin: null,
};

const activityState = createActivityWidgetState();

function abortPendingFetches(): void {
	for (const controller of pendingFetches.values()) {
		controller.abort();
	}
	pendingFetches.clear();
}

function closeCurator(): void {
	const win = runtimeState.glimpseWin;
	runtimeState.glimpseWin = null;
	try { win?.close(); } catch {}
	cancelPendingCurate(runtimeState);
	if (runtimeState.activeCurator) {
		runtimeState.activeCurator.close();
		runtimeState.activeCurator = null;
	}
}

function handleSessionChange(ctx: ExtensionContext): void {
	abortPendingFetches();
	closeCurator();
	clearCloneCache();
	runtimeState.sessionActive = true;
	restoreFromSession(ctx);
	refreshActivityForSession(activityState, ctx);
}

export function registerWebSearchFeatures(pi: ExtensionAPI, initConfig: WebSearchConfig): void {
	const curateKey = initConfig.shortcuts?.curate || DEFAULT_SHORTCUTS.curate;
	const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;

	function startBackgroundFetch(urls: string[]): string | null {
		if (urls.length === 0) return null;
		const fetchId = generateId();
		const controller = new AbortController();
		pendingFetches.set(fetchId, controller);
		fetchAllContent(urls, controller.signal)
			.then(async (fetched) => {
				if (!runtimeState.sessionActive || !pendingFetches.has(fetchId)) return;
				const data: StoredSearchData = {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				};
				storeResult(fetchId, data);
				try {
					pi.appendEntry("web-search-results", data);
					const ok = fetched.filter(f => !f.error).length;
					// Keep the fetch pending until notification admission settles so session
					// changes can still clear the entry and abort its controller while admission is in flight.
					await pi.sendMessage(
						{
							customType: "web-search-content-ready",
							content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. Full page content now available.`,
							display: true,
						},
						{ triggerTurn: true },
					);
				} catch (error) {
					if (!isStaleExtensionContextError(error)) throw error;
				}
			})
			.catch(async (err) => {
				if (isStaleExtensionContextError(err)) return;
				if (!runtimeState.sessionActive || !pendingFetches.has(fetchId)) return;
				const message = err instanceof Error ? err.message : String(err);
				const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
				if (!isAbort) {
					try {
						await pi.sendMessage(
							{
								customType: "web-search-error",
								content: `Content fetch failed [${fetchId}]: ${message}`,
								display: true,
							},
							{ triggerTurn: false },
						);
					} catch (error) {
						if (!isStaleExtensionContextError(error)) throw error;
					}
				}
			})
			.finally(() => { pendingFetches.delete(fetchId); })
			.catch((error) => {
				if (!isStaleExtensionContextError(error)) {
					console.error("Web search background fetch notification failed:", error);
				}
			});
		return fetchId;
	}

	const buildReturn: SearchReturnBuilder = (opts) => buildSearchReturn(opts, { pi, startBackgroundFetch });
	const openCuratorBrowser = (pc: PendingCurate, searchesComplete = true) => openCuratorBrowserForSearch(
		{ pi, state: runtimeState, buildSearchReturn: buildReturn, closeCurator },
		pc,
		searchesComplete,
	);

	pi.registerShortcut(curateKey, {
		description: "Review search results",
		handler: async (ctx) => {
			const pc = runtimeState.pendingCurate;
			if (!pc) return;

			if (pc.phase === "searching") {
				pc.browserPromise = openCuratorBrowser(pc, false);
				ctx.ui.notify("Opening curator — remaining searches will stream in", "info");
				return;
			}
		},
	});

	pi.registerShortcut(activityKey, {
		description: "Toggle web search activity",
		handler: async (ctx) => {
			toggleActivityWidget(activityState, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));

	pi.on("session_shutdown", () => {
		runtimeState.sessionActive = false;
		abortPendingFetches();
		closeCurator();
		clearCloneCache();
		clearResults();
		shutdownActivityWidget(activityState);
	});

	registerWebSearchTool(pi, {
		state: runtimeState,
		closeCurator,
		openCuratorBrowser,
		buildSearchReturn: buildReturn,
	});

	registerContentTools(pi, {
		maxInlineContent: MAX_INLINE_CONTENT,
		stripThumbnails,
		formatFullResults,
	});

	registerWebSearchCommand(pi, {
		state: runtimeState,
		closeCurator,
		buildSearchReturn: buildReturn,
	});
}
