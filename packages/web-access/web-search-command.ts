import type { ExtensionAPI } from "@bastani/atomic";
import { randomUUID } from "node:crypto";
import { startCuratorServer, type CuratorServerHandle } from "./curator-server.js";
import { search } from "./gemini-search.js";
import type { QueryResultData } from "./storage.js";
import type { SummaryGenerationContext } from "./summary-review.js";
import { openCuratorWindow } from "./web-search-browser.js";
import {
	collectAllResultsAndUrls,
	extractDomain,
	filterByQueryIndices,
} from "./web-search-formatting.js";
import type { SearchReturnBuilder, SearchReturnOptions, SearchReturnPayload } from "./web-search-return.js";
import { generateSummaryForSelectedIndices, loadSummaryModelChoices, resolveSummaryForSubmit, rewriteSearchQuery } from "./web-search-summary.js";
import type { WebSearchRuntimeState } from "./web-search-types.js";
import { loadCuratorBootstrap, normalizeProviderInput, normalizeQueryList, saveConfig, type CuratorBootstrap } from "./web-search-config.js";

interface RegisterWebSearchCommandDeps {
	state: WebSearchRuntimeState;
	closeCurator(): void;
	buildSearchReturn: SearchReturnBuilder;
}

export function registerWebSearchCommand(pi: ExtensionAPI, deps: RegisterWebSearchCommandDeps): void {
	pi.registerCommand("websearch", {
		description: "Open web search curator",
		handler: async (args, ctx) => {
			deps.closeCurator();
			const sessionToken = randomUUID();

			const raw = args.trim();
			const queries = raw.length > 0
				? normalizeQueryList(raw.split(","))
				: [];

			let bootstrap: CuratorBootstrap;
			try {
				bootstrap = await loadCuratorBootstrap(undefined);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to load web search config: ${message}`, "error");
				return;
			}
			const availableProviders = bootstrap.availableProviders;
			const initialProvider = bootstrap.defaultProvider;
			const curatorTimeoutSeconds = bootstrap.timeoutSeconds;
			let currentProvider = initialProvider;
			const summaryContext: SummaryGenerationContext = {
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
			};
			const summaryModelChoices = await loadSummaryModelChoices(summaryContext);

			ctx.ui.notify("Opening web search curator...", "info");

			const collected = new Map<number, QueryResultData>();
			const searchAbort = new AbortController();
			let aborted = false;
			let commandHandle: CuratorServerHandle | null = null;

			function sendFollowUpFromReturn(payload: SearchReturnPayload) {
				pi.sendMessage({
					customType: "web-search-results",
					content: payload.content,
					display: "tool",
					details: payload.details,
				}, { triggerTurn: true, deliverAs: "followUp" });
			}

			try {
				const handle = await startCuratorServer(
					{
						queries,
						sessionToken,
						timeout: curatorTimeoutSeconds,
						availableProviders,
						defaultProvider: initialProvider,
						summaryModels: summaryModelChoices.summaryModels,
						defaultSummaryModel: summaryModelChoices.defaultSummaryModel,
					},
					{
						async onSummarize(selectedQueryIndices, summarizeSignal, model, feedback) {
							if (commandHandle && deps.state.activeCurator !== commandHandle) {
								throw new Error("Curator session is no longer active.");
							}
							return generateSummaryForSelectedIndices(
								selectedQueryIndices,
								collected,
								summaryContext,
								summarizeSignal,
								model,
								feedback,
							);
						},
						onSubmit(payload) {
							if (commandHandle && deps.state.activeCurator !== commandHandle) return;
							aborted = true;
							searchAbort.abort();
							const filtered = payload.selectedQueryIndices.length > 0
								? filterByQueryIndices(payload.selectedQueryIndices, collected)
								: collectAllResultsAndUrls(collected);
							const base: SearchReturnOptions = {
								queryList: filtered.results.map(r => r.query),
								results: filtered.results,
								urls: filtered.urls,
								includeContent: false,
								curated: true,
								curatedFrom: collected.size,
							};
							if (!payload.rawResults) {
								const resolvedSummary = resolveSummaryForSubmit(payload, collected);
								base.workflow = "summary-review";
								base.approvedSummary = resolvedSummary.approvedSummary;
								base.summaryMeta = resolvedSummary.summaryMeta;
							}
							sendFollowUpFromReturn(deps.buildSearchReturn(base));
							deps.closeCurator();
						},
						onCancel(reason) {
							if (commandHandle && deps.state.activeCurator !== commandHandle) return;
							aborted = true;
							searchAbort.abort();
							if (reason === "timeout") {
								const all = collectAllResultsAndUrls(collected);
								const resolvedSummary = resolveSummaryForSubmit({ selectedQueryIndices: [], summary: undefined, summaryMeta: undefined }, collected);
								sendFollowUpFromReturn(deps.buildSearchReturn({
									queryList: all.results.map(r => r.query),
									results: all.results,
									urls: all.urls,
									includeContent: false,
									curated: true,
									curatedFrom: collected.size,
									workflow: "summary-review",
									approvedSummary: resolvedSummary.approvedSummary,
									summaryMeta: resolvedSummary.summaryMeta,
								}));
							}
							deps.closeCurator();
						},
						onProviderChange(provider) {
							if (commandHandle && deps.state.activeCurator !== commandHandle) return;
							const normalized = normalizeProviderInput(provider);
							if (!normalized || normalized === "auto") return;
							currentProvider = normalized;
							try {
								saveConfig({ provider: normalized });
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								console.error(`Failed to persist default provider: ${message}`);
							}
						},
						async onAddSearch(query, queryIndex, provider) {
							if (commandHandle && deps.state.activeCurator !== commandHandle) {
								throw new Error("Curator session is no longer active.");
							}
							const normalizedProvider = normalizeProviderInput(provider);
							const requestedProvider = !normalizedProvider || normalizedProvider === "auto"
								? currentProvider
								: normalizedProvider;
							try {
								const { answer, results, provider: actualProvider } = await search(query, {
									provider: requestedProvider,
									signal: searchAbort.signal,
								});
								if (commandHandle && deps.state.activeCurator !== commandHandle) {
									throw new Error("Curator session is no longer active.");
								}
								collected.set(queryIndex, { query, answer, results, error: null, provider: actualProvider });
								return {
									answer,
									results: results.map(r => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
									provider: actualProvider,
								};
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								if (!commandHandle || deps.state.activeCurator === commandHandle) {
									collected.set(queryIndex, { query, answer: "", results: [], error: message, provider: requestedProvider });
								}
								throw err;
							}
						},
						async onRewriteQuery(query, rewriteSignal) {
							if (commandHandle && deps.state.activeCurator !== commandHandle) {
								throw new Error("Curator session is no longer active.");
							}
							return rewriteSearchQuery(query, summaryContext, rewriteSignal);
						},
					},
				);

				commandHandle = handle;
				deps.state.activeCurator = handle;
				await openCuratorWindow(
					pi,
					handle.url,
					"Search Curator",
					win => { deps.state.glimpseWin = win; },
					win => {
						if (deps.state.glimpseWin === win) {
							deps.state.glimpseWin = null;
							deps.closeCurator();
						}
					},
				);

				if (queries.length > 0) {
					(async () => {
						for (let qi = 0; qi < queries.length; qi++) {
							if (aborted || deps.state.activeCurator !== handle) break;
							const requestedProvider = currentProvider;
							try {
								const { answer, results, provider } = await search(queries[qi], {
									provider: requestedProvider,
									signal: searchAbort.signal,
								});
								if (aborted || deps.state.activeCurator !== handle) break;
								handle.pushResult(qi, {
									answer,
									results: results.map(r => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
									provider,
								});
								collected.set(qi, { query: queries[qi], answer, results, error: null, provider });
							} catch (err) {
								if (aborted || deps.state.activeCurator !== handle) break;
								const message = err instanceof Error ? err.message : String(err);
								handle.pushError(qi, message, requestedProvider);
								collected.set(qi, { query: queries[qi], answer: "", results: [], error: message, provider: requestedProvider });
							}
						}
						if (!aborted && deps.state.activeCurator === handle) handle.searchesDone();
					})();
				} else {
					if (deps.state.activeCurator === handle) handle.searchesDone();
				}
			} catch (err) {
				deps.closeCurator();
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to open curator: ${message}`, "error");
			}
		},
	});
}
