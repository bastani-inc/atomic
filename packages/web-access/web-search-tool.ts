import type { ExtensionAPI } from "@bastani/atomic";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { renderWebSearchResult } from "./result-renderers.js";
import type { ExtractedContent } from "./extract.js";
import { search } from "./gemini-search.js";
import { type QueryResultData } from "./storage.js";
import type { SummaryGenerationContext } from "./summary-review.js";
import {
	loadConfig,
	loadConfigForExtensionInit,
	loadCuratorBootstrap,
	normalizeProviderInput,
	normalizeQueryList,
	resolveWorkflow,
	type CuratorWorkflow,
} from "./web-search-config.js";
import { buildCurationCancelledReturn, extractDomain } from "./web-search-formatting.js";
import type { SearchReturnBuilder } from "./web-search-return.js";
import { loadSummaryModelChoices } from "./web-search-summary.js";
import type { PendingCurate, WebSearchRuntimeState } from "./web-search-types.js";

interface RegisterWebSearchToolDeps {
	state: WebSearchRuntimeState;
	closeCurator(): void;
	openCuratorBrowser(pc: PendingCurate, searchesComplete?: boolean): Promise<void>;
	buildSearchReturn: SearchReturnBuilder;
}

export function registerWebSearchTool(pi: ExtensionAPI, deps: RegisterWebSearchToolDeps): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Search the web using Perplexity AI, Exa, or Gemini. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation. Provider auto-selects: Exa (direct API with key, MCP fallback without), else Perplexity (needs key), else Gemini API (needs key), else Gemini Web (needs a supported Chromium-based browser login).`,
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results)." })),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(
				StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" }),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			provider: Type.Optional(
				StringEnum(["auto", "perplexity", "gemini", "exa"], { description: "Search provider (default: auto)" }),
			),
			workflow: Type.Optional(
				StringEnum(["none", "summary-review"], {
					description: "Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: (params.query !== undefined ? [params.query] : []);
			const queryList = normalizeQueryList(rawQueryList);
			const configWorkflow = loadConfigForExtensionInit().workflow;
			const workflow = resolveWorkflow(params.workflow ?? configWorkflow, ctx?.hasUI !== false);
			const shouldCurate = workflow !== "none";

			if (queryList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
					details: { error: "No query provided" },
				};
			}

			if (shouldCurate && !ctx) {
				return {
					content: [{ type: "text", text: "Error: Curation requires an active extension context." }],
					details: { error: "Missing extension context" },
				};
			}

			if (shouldCurate) {
				const activeCtx = ctx;
				if (!activeCtx) {
					return {
						content: [{ type: "text", text: "Error: Curation requires an active extension context." }],
						details: { error: "Missing extension context" },
					};
				}
				deps.closeCurator();

				let resolvePromise: (value: unknown) => void = () => {};
				const promise = new Promise<unknown>((resolve) => {
					resolvePromise = resolve;
				});
				const includeContent = params.includeContent ?? false;
				const searchResults = new Map<number, QueryResultData>();
				const allInlineContent: ExtractedContent[] = [];
				const searchAbort = new AbortController();
				const searchSignal = signal
					? AbortSignal.any([signal, searchAbort.signal])
					: searchAbort.signal;
				let cancelled = false;

				const bootstrap = await loadCuratorBootstrap(params.provider);
				const availableProviders = bootstrap.availableProviders;
				const defaultProvider = bootstrap.defaultProvider;
				const curatorTimeoutSeconds = bootstrap.timeoutSeconds;
				const curatorWorkflow: CuratorWorkflow = "summary-review";

				const summaryContext: SummaryGenerationContext = {
					model: activeCtx.model,
					modelRegistry: activeCtx.modelRegistry,
				};
				const summaryModelChoices = await loadSummaryModelChoices(summaryContext);

				const pc: PendingCurate = {
					phase: "searching",
					workflow: curatorWorkflow,
					summaryContext,
					searchResults,
					allInlineContent,
					queryList,
					includeContent,
					numResults: params.numResults,
					recencyFilter: params.recencyFilter,
					domainFilter: params.domainFilter,
					availableProviders,
					defaultProvider,
					summaryModels: summaryModelChoices.summaryModels,
					defaultSummaryModel: summaryModelChoices.defaultSummaryModel,
					timeoutSeconds: curatorTimeoutSeconds,
					onUpdate: onUpdate as PendingCurate["onUpdate"],
					signal,
					abortSearches: () => {
						if (!searchAbort.signal.aborted) searchAbort.abort();
					},
					finish: () => {},
					cancel: () => {},
				};

				const onAbort = () => deps.closeCurator();
				const finish = (value: unknown) => {
					if (cancelled) return;
					cancelled = true;
					pc.abortSearches();
					signal?.removeEventListener("abort", onAbort);
					deps.state.pendingCurate = null;
					resolvePromise(value);
				};

				const cancel = (reason: "user" | "stale" = "stale") => {
					if (cancelled) return;
					finish(buildCurationCancelledReturn(reason));
				};

				pc.finish = finish;
				pc.cancel = cancel;
				deps.state.pendingCurate = pc;
				signal?.addEventListener("abort", onAbort, { once: true });
				pc.browserPromise = deps.openCuratorBrowser(pc, false);

				for (let qi = 0; qi < queryList.length; qi++) {
					if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
					onUpdate?.({
						content: [{ type: "text", text: `Searching ${qi + 1}/${queryList.length}: "${queryList[qi]}"...` }],
						details: { phase: "searching", progress: qi / queryList.length, currentQuery: queryList[qi] },
					});
					const requestedProvider = pc.defaultProvider;
					try {
						const { answer, results, inlineContent, provider } = await search(queryList[qi], {
							provider: requestedProvider,
							numResults: params.numResults,
							recencyFilter: params.recencyFilter,
							domainFilter: params.domainFilter,
							includeContent: params.includeContent,
							signal: searchSignal,
						});
						if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
						searchResults.set(qi, { query: queryList[qi], answer, results, error: null, provider });
						if (inlineContent) allInlineContent.push(...inlineContent);
						if (deps.state.activeCurator) {
							deps.state.activeCurator.pushResult(qi, {
								answer,
								results: results.map(r => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
								provider,
							});
						}
					} catch (err) {
						if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
						const message = err instanceof Error ? err.message : String(err);
						searchResults.set(qi, { query: queryList[qi], answer: "", results: [], error: message, provider: requestedProvider });
						if (deps.state.activeCurator) {
							deps.state.activeCurator.pushError(qi, message, requestedProvider);
						}
					}
				}

				if (signal?.aborted || cancelled || searchAbort.signal.aborted) {
					cancel();
					return promise;
				}

				await pc.browserPromise;
				if (deps.state.activeCurator) {
					deps.state.activeCurator.searchesDone();
					pc.onUpdate?.({
						content: [{ type: "text", text: "All searches complete — waiting for summary approval in browser..." }],
						details: { phase: "curating", progress: 1 },
					});
				}

				return promise;
			}

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];
			const resolvedProvider = normalizeProviderInput(params.provider ?? loadConfig().provider);

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];

				onUpdate?.({
					content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider } = await search(query, {
						provider: resolvedProvider,
						numResults: params.numResults,
						recencyFilter: params.recencyFilter,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						signal,
					});

					searchResults.push({ query, answer, results, error: null, provider });
					for (const r of results) {
						if (!allUrls.includes(r.url)) {
							allUrls.push(r.url);
						}
					}
					if (inlineContent) allInlineContent.push(...inlineContent);
				} catch (err) {
					signal?.throwIfAborted();
					const message = err instanceof Error ? err.message : String(err);
					const requestedProvider = typeof resolvedProvider === "string" && resolvedProvider !== "auto"
						? resolvedProvider
						: undefined;
					searchResults.push({ query, answer: "", results: [], error: message, provider: requestedProvider });
				}
			}

			signal?.throwIfAborted();
			return deps.buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
			});
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: (input.query !== undefined ? [input.query] : []);
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult: renderWebSearchResult,
	});
}
