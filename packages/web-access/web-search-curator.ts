import type { ExtensionAPI } from "@bastani/atomic";
import { randomUUID } from "node:crypto";
import { startCuratorServer, type CuratorServerHandle } from "./curator-server.js";
import { search } from "./gemini-search.js";
import {
	buildCurationCancelledReturn,
	collectAllResultsAndUrls,
	extractDomain,
	filterByQueryIndices,
} from "./web-search-formatting.js";
import type { SearchReturnBuilder, SearchReturnOptions } from "./web-search-return.js";
import { generateSummaryForSelectedIndices, resolveSummaryForSubmit, rewriteSearchQuery } from "./web-search-summary.js";
import { openCuratorWindow } from "./web-search-browser.js";
import type { PendingCurate, WebSearchRuntimeState } from "./web-search-types.js";
import { normalizeProviderInput, saveConfig } from "./web-search-config.js";

interface OpenCuratorBrowserDeps {
	pi: ExtensionAPI;
	state: WebSearchRuntimeState;
	buildSearchReturn: SearchReturnBuilder;
	closeCurator(): void;
}

export async function openCuratorBrowser(
	deps: OpenCuratorBrowserDeps,
	pc: PendingCurate,
	searchesComplete = true,
): Promise<void> {
	let handle: CuratorServerHandle | null = null;
	try {
		pc.phase = "curating";

		const searchAbort = new AbortController();
		const addSearchSignal = pc.signal
			? AbortSignal.any([pc.signal, searchAbort.signal])
			: searchAbort.signal;

		const sessionToken = randomUUID();
		handle = await startCuratorServer(
			{
				queries: pc.queryList,
				sessionToken,
				timeout: pc.timeoutSeconds,
				availableProviders: pc.availableProviders,
				defaultProvider: pc.defaultProvider,
				summaryModels: pc.summaryModels,
				defaultSummaryModel: pc.defaultSummaryModel,
			},
			{
				async onSummarize(selectedQueryIndices, summarizeSignal, model, feedback) {
					if (deps.state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
					pc.onUpdate?.({
						content: [{ type: "text", text: "Generating summary draft..." }],
						details: { phase: "generating-summary", progress: 0.9 },
					});
					const draft = await generateSummaryForSelectedIndices(
						selectedQueryIndices,
						pc.searchResults,
						pc.summaryContext,
						summarizeSignal,
						model,
						feedback,
					);
					if (deps.state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
					pc.onUpdate?.({
						content: [{ type: "text", text: "Summary draft ready — waiting for approval..." }],
						details: { phase: "waiting-for-approval", progress: 1 },
					});
					return draft;
				},
				onSubmit(payload) {
					if (deps.state.pendingCurate !== pc) return;
					searchAbort.abort();
					const filtered = payload.selectedQueryIndices.length > 0
						? filterByQueryIndices(payload.selectedQueryIndices, pc.searchResults)
						: collectAllResultsAndUrls(pc.searchResults);
					const filteredInline = pc.allInlineContent.filter(c => filtered.urls.includes(c.url));
					const base: SearchReturnOptions = {
						queryList: filtered.results.map(r => r.query),
						results: filtered.results,
						urls: filtered.urls,
						includeContent: pc.includeContent,
						inlineContent: filteredInline.length > 0 ? filteredInline : undefined,
						curated: true,
						curatedFrom: pc.searchResults.size,
					};
					if (!payload.rawResults) {
						const resolvedSummary = resolveSummaryForSubmit(payload, pc.searchResults);
						base.workflow = pc.workflow;
						base.approvedSummary = resolvedSummary.approvedSummary;
						base.summaryMeta = resolvedSummary.summaryMeta;
					}
					pc.finish(deps.buildSearchReturn(base));
					deps.closeCurator();
				},
				onCancel(reason) {
					if (deps.state.pendingCurate !== pc) return;
					searchAbort.abort();
					if (reason === "timeout") {
						const resolvedSummary = resolveSummaryForSubmit({ selectedQueryIndices: [], summary: undefined, summaryMeta: undefined }, pc.searchResults);
						const all = collectAllResultsAndUrls(pc.searchResults);
						const filteredInline = pc.allInlineContent.filter(c => all.urls.includes(c.url));
						pc.finish(deps.buildSearchReturn({
							queryList: all.results.map(r => r.query),
							results: all.results,
							urls: all.urls,
							includeContent: pc.includeContent,
							inlineContent: filteredInline.length > 0 ? filteredInline : undefined,
							curated: true,
							curatedFrom: pc.searchResults.size,
							workflow: pc.workflow,
							approvedSummary: resolvedSummary.approvedSummary,
							summaryMeta: resolvedSummary.summaryMeta,
						}));
					} else {
						pc.finish(buildCurationCancelledReturn(reason));
					}
					deps.closeCurator();
				},
				onProviderChange(provider) {
					if (deps.state.pendingCurate !== pc) return;
					const normalized = normalizeProviderInput(provider);
					if (!normalized || normalized === "auto") return;
					pc.defaultProvider = normalized;
					try {
						saveConfig({ provider: normalized });
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						console.error(`Failed to persist default provider: ${message}`);
					}
				},
				async onAddSearch(query, queryIndex, provider) {
					if (deps.state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
					const normalizedProvider = normalizeProviderInput(provider);
					const requestedProvider = !normalizedProvider || normalizedProvider === "auto"
						? pc.defaultProvider
						: normalizedProvider;
					try {
						const { answer, results, inlineContent, provider: actualProvider } = await search(query, {
							provider: requestedProvider,
							numResults: pc.numResults,
							recencyFilter: pc.recencyFilter,
							domainFilter: pc.domainFilter,
							includeContent: pc.includeContent,
							signal: addSearchSignal,
						});
						if (deps.state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
						pc.searchResults.set(queryIndex, { query, answer, results, error: null, provider: actualProvider });
						if (inlineContent) pc.allInlineContent.push(...inlineContent);
						return {
							answer,
							results: results.map(r => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
							provider: actualProvider,
						};
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						if (deps.state.pendingCurate === pc) {
							pc.searchResults.set(queryIndex, { query, answer: "", results: [], error: message, provider: requestedProvider });
						}
						throw err;
					}
				},
				async onRewriteQuery(query, rewriteSignal) {
					if (deps.state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
					return rewriteSearchQuery(query, pc.summaryContext, rewriteSignal);
				},
			},
		);

		if (deps.state.pendingCurate !== pc) {
			handle.close();
			return;
		}

		deps.state.activeCurator = handle;

		for (const [qi, data] of pc.searchResults) {
			if (data.error) {
				handle.pushError(qi, data.error, data.provider);
			} else {
				handle.pushResult(qi, {
					answer: data.answer,
					results: data.results.map(r => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
					provider: data.provider || pc.defaultProvider,
				});
			}
		}
		if (searchesComplete) handle.searchesDone();

		pc.onUpdate?.({
			content: [{ type: "text", text: searchesComplete ? "Waiting for summary approval in browser..." : "Searches streaming to browser..." }],
			details: { phase: "curating", progress: searchesComplete ? 1 : 0.5 },
		});

		await openCuratorWindow(
			deps.pi,
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
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Failed to open curator UI: ${message}`);
		if (deps.state.pendingCurate === pc || (handle && deps.state.activeCurator === handle)) {
			deps.closeCurator();
		}
	}
}
