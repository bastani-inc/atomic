import type { ExtensionAPI } from "@bastani/atomic";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	renderCodeSearchResult,
	renderFetchContentResult,
	renderGetSearchContentResult,
} from "./result-renderers.js";
import { fetchAllContent, type ExtractedContent } from "./extract.js";
import { executeCodeSearch } from "./code-search.js";
import {
	generateId,
	getResult,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.js";

interface RegisterContentToolsDeps {
	maxInlineContent: number;
	stripThumbnails(results: ExtractedContent[]): ExtractedContent[];
	formatFullResults(queryData: QueryResultData): string;
}

export function registerContentTools(pi: ExtensionAPI, deps: RegisterContentToolsDeps): void {
	pi.registerTool({
		name: "code_search",
		label: "Code Search",
		description: "Ask DeepWiki about code, architecture, and APIs in a public GitHub repository. Requires repoName in owner/repo format. No API key required; no web-search fallback.",
		promptSnippet:
			"Use for repository-specific programming questions. Supply repoName (owner/repo) and query; use web_search for broader discovery.",
		parameters: Type.Object({
			repoName: Type.String({ pattern: "^[^\\s/]+/[^\\s/]+$", description: "Public GitHub repository in owner/repo format" }),
			query: Type.String({ pattern: "\\S", description: "Question about the repository, sent verbatim to DeepWiki" }),
			maxTokens: Type.Optional(Type.Integer({
				minimum: 1000,
				maximum: 50000,
				description: "Best-effort output limit, approximately four characters per token (default: 5000)",
			})),
		}),

		async execute(toolCallId, params, signal) {
			return executeCodeSearch(toolCallId, params, signal);
		},

		renderCall(args, theme) {
			const { query } = args as { query?: string };
			// This status-line preview is built and dropped within the same turn, so a bare slice is sufficient.
			const display = !query
				? "(no query)"
				: query.length > 70 ? query.slice(0, 67) + "..." : query;
			return new Text(theme.fg("toolTitle", theme.bold("code_search ")) + theme.fg("accent", display), 0, 0);
		},

		renderResult: renderCodeSearchResult,
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: 'Fetch webpages, PDFs, GitHub repositories, YouTube videos, or local video files. For ordinary pages, pass only {"urls":["https://example.com"]}; readable content is returned as markdown. For video analysis, include the user\'s question in prompt. Optional frames and timestamp extract images only from YouTube or local videos and are ignored for other inputs, including in mixed batches. Content is stored for get_search_content. Blocked or unreadable pages use extraction fallbacks.',
		promptSnippet:
			"Fetch webpages with urls only. For YouTube or local video analysis, include the user's question in prompt; omit frames and timestamp unless images are wanted.",
		parameters: Type.Object({
			urls: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description: 'URLs or local video paths to fetch. Always use an array, even for one URL: {"urls":["https://example.com"]}. Multiple URLs are fetched in parallel.',
			}),
			forceClone: Type.Optional(Type.Boolean({
				description: "GitHub repositories only: allow cloning above the configured size threshold. Omit for webpages and videos.",
			})),
			prompt: Type.Optional(Type.String({
				description: "YouTube/local video analysis only: the user's specific question. Omit for webpages; this is not a webpage search or extraction filter.",
			})),
			timestamp: Type.Optional(Type.String({
				description: "YouTube/local video images only: seconds ('85'), time ('1:25'), or range ('1:25-2:00'). Omit for text/transcripts. Ignored for non-video inputs. Ranges default to 6 frames; use frames to adjust.",
			})),
			frames: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: 12,
				description: "YouTube/local video images only: 1-12 frames. Alone, samples the whole video; with a range, samples that span; with a single timestamp, uses 5s intervals. Ignored for non-video inputs. Omit for text/transcripts. Requires ffmpeg, plus yt-dlp for YouTube.",
			})),
			model: Type.Optional(Type.String({
				description: "Gemini model override for YouTube/local video analysis only. Omit to use the configured default; does not select the webpage extraction model.",
			})),
		}, { additionalProperties: false }),

		async execute(_toolCallId, params, signal, onUpdate) {
			const urlList = params.urls;

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});

			const fetchResults = await fetchAllContent(urlList, signal, {
				forceClone: params.forceClone,
				prompt: params.prompt,
				timestamp: params.timestamp,
				frames: params.frames,
				model: params.model,
			});
			signal?.throwIfAborted();
			const successful = fetchResults.filter((r) => !r.error).length;
			const totalChars = fetchResults.reduce((sum, r) => sum + r.content.length, 0);

			const responseId = generateId();
			const data: StoredSearchData = {
				id: responseId,
				type: "fetch",
				timestamp: Date.now(),
				urls: deps.stripThumbnails(fetchResults),
			};
			storeResult(responseId, data);
			pi.appendEntry("web-search-results", data);

			if (urlList.length === 1) {
				const result = fetchResults[0];
				if (result.error) {
					return {
						content: [{ type: "text", text: `Error: ${result.error}` }],
						details: { outcome: "all_failed", stage: "fetch", urls: urlList, urlCount: 1, successful: 0, error: result.error, responseId, prompt: params.prompt, timestamp: params.timestamp, frames: params.frames },
					};
				}

				const fullLength = result.content.length;
				const truncated = fullLength > deps.maxInlineContent;
				let output = truncated
					? result.content.slice(0, deps.maxInlineContent) + "\n\n[Content truncated...]"
					: result.content;

				if (truncated) {
					output += `\n\n---\nShowing ${deps.maxInlineContent} of ${fullLength} chars. ` +
						`Use get_search_content({ responseId: "${responseId}", urlIndex: 0 }) for full content.`;
				}

				const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
				if (result.frames?.length) {
					for (const frame of result.frames) {
						content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
						content.push({ type: "text", text: `Frame at ${frame.timestamp}` });
					}
				} else if (result.thumbnail) {
					content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
				}
				content.push({ type: "text", text: output });

				const imageCount = (result.frames?.length ?? 0) + (result.thumbnail ? 1 : 0);
				return {
					content,
					details: {
						urls: urlList,
						urlCount: 1,
						successful: 1,
						totalChars: fullLength,
						title: result.title,
						responseId,
						truncated,
						hasImage: imageCount > 0,
						imageCount,
						prompt: params.prompt,
						timestamp: params.timestamp,
						frames: params.frames,
						duration: result.duration,
					},
				};
			}

			let output = "## Fetched URLs\n\n";
			for (const { url, title, content, error } of fetchResults) {
				if (error) {
					output += `- ${url}: Error - ${error}\n`;
					if (content.length > 0) {
						output += `\nPartial content (incomplete):\n${content.slice(0, deps.maxInlineContent)}\n`;
						if (content.length > deps.maxInlineContent) output += "[Partial content truncated...]\n";
						output += "\n";
					}
				} else {
					output += `- ${title || url} (${content.length} chars)\n`;
				}
			}
			const allFailed = successful === 0;
			if (allFailed) {
				const contentStatus = totalChars > 0
					? "Partial content was retained; extraction is incomplete."
					: "No content was retrieved.";
				output = `All ${urlList.length} URL fetch(es) failed. ${contentStatus}\n\n${output}` +
					"\nCheck each URL and its error above. Retry transient failures individually with " +
					'fetch_content({ urls: ["<failed URL>"] }). If access is blocked or extraction keeps failing, ' +
					"try an accessible alternate URL or use web_search to find the information. " +
					(totalChars > 0
						? "get_search_content cannot recover the missing content; use the incomplete excerpts above with caution."
						: "get_search_content cannot recover content from these failed fetches.");
			} else {
				output += `\n---\nUse get_search_content({ responseId: "${responseId}", urlIndex: 0 }) to retrieve full content.`;
			}
			return {
				content: [{ type: "text", text: output }],
				details: {
					...(allFailed ? { outcome: "all_failed", stage: "fetch", error: output, failedUrls: urlList.length } : {}),
					urls: urlList, urlCount: urlList.length, successful, totalChars, responseId,
				},
			};
		},

		renderCall(args, theme) {
			const { url, urls, prompt, timestamp, frames, model } = args as { url?: string; urls?: string[]; prompt?: string; timestamp?: string; frames?: number; model?: string };
			const urlList = urls ?? (url ? [url] : []);
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				const display = urlList[0].length > 60 ? urlList[0].slice(0, 57) + "..." : urlList[0];
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("muted", "  " + display));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			if (timestamp) lines.push(theme.fg("dim", "  timestamp: ") + theme.fg("warning", timestamp));
			if (typeof frames === "number") lines.push(theme.fg("dim", "  frames: ") + theme.fg("warning", String(frames)));
			if (prompt) {
				const display = prompt.length > 250 ? prompt.slice(0, 247) + "..." : prompt;
				lines.push(theme.fg("dim", "  prompt: ") + theme.fg("muted", `"${display}"`));
			}
			if (model) lines.push(theme.fg("dim", "  model: ") + theme.fg("warning", model));
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult: renderFetchContentResult,
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve full content from a previous web_search or fetch_content call.",
		promptSnippet:
			"Use after web_search/fetch_content when full stored content is needed via responseId plus query/url selectors.",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
			query: Type.Optional(Type.String({ description: "Get content for this query (web_search)" })),
			queryIndex: Type.Optional(Type.Number({ description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Number({ description: "Get content for URL at index" })),
		}),

		async execute(_toolCallId, params) {
			const data = getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for "${params.responseId}"` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			if (data.type === "search" && data.queries) {
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = data.queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = data.queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query "${params.query}" not found. Available: ${available}` }],
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = data.queries[params.queryIndex];
					if (!queryData) {
						return {
							content: [{ type: "text", text: `Index ${params.queryIndex} out of range (0-${data.queries.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex. Available: ${available}` }],
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error for "${queryData.query}": ${queryData.error}` }],
						details: { error: queryData.error, query: queryData.query },
					};
				}

				return {
					content: [{ type: "text", text: deps.formatFullResults(queryData) }],
					details: { query: queryData.query, resultCount: queryData.results.length },
				};
			}

			if (data.type === "fetch" && data.urls) {
				let urlData: ExtractedContent | undefined;

				if (params.url !== undefined) {
					urlData = data.urls.find((u) => u.url === params.url);
					if (!urlData) {
						const available = data.urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL not found. Available:\n  ${available}` }],
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					urlData = data.urls[params.urlIndex];
					if (!urlData) {
						return {
							content: [{ type: "text", text: `Index ${params.urlIndex} out of range (0-${data.urls.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex. Available:\n  ${available}` }],
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error for ${urlData.url}: ${urlData.error}` }],
						details: { error: urlData.error, url: urlData.url },
					};
				}

				return {
					content: [{ type: "text", text: `# ${urlData.title}\n\n${urlData.content}` }],
					details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length },
				};
			}

			return {
				content: [{ type: "text", text: "Invalid stored data format" }],
				details: { error: "Invalid data" },
			};
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || responseId.slice(0, 8)), 0, 0);
		},

		renderResult: renderGetSearchContentResult,
	});
}
