import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@bastani/atomic-ai";
import { type KeyId, Text } from "@bastani/atomic-tui";
import type { SessionEntry } from "../../session-manager.ts";
import type { LazyBuiltinController, LazyBuiltinSpec } from "../lazy-builtin.js";
import type { ToolDefinition } from "../types.ts";

type ToolRenderResultArgs = Parameters<NonNullable<ToolDefinition["renderResult"]>>;

const WEB_ACCESS_TOOLS = new Set(["web_search", "code_search", "fetch_content", "get_search_content"]);

function isAllFailedWebResult(toolName: string, details: unknown): boolean {
	if (toolName !== "web_search" && toolName !== "fetch_content") return false;
	if (!details || typeof details !== "object") return false;
	return Reflect.get(details, "outcome") === "all_failed";
}

function hasWebAccessHistory(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			WEB_ACCESS_TOOLS.has(entry.message.toolName),
	);
}

async function getInitialShortcutConfig(): Promise<{ curate: string; activity: string }> {
	const defaults = { curate: "ctrl+shift+s", activity: "ctrl+shift+w" };
	for (const configPath of [
		join(homedir(), ".atomic", "web-search.json"),
		join(homedir(), ".pi", "web-search.json"),
	]) {
		try {
			const raw = await readFile(configPath, "utf8");
			const parsed = JSON.parse(raw) as { shortcuts?: { curate?: string; activity?: string } };
			return {
				curate: parsed.shortcuts?.curate?.trim() || defaults.curate,
				activity: parsed.shortcuts?.activity?.trim() || defaults.activity,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			console.error(`[pi-web-access] Failed to inspect shortcuts in ${configPath}:`, error);
		}
	}
	return defaults;
}

function renderResultFallback(controller: LazyBuiltinController, name: string, args: ToolRenderResultArgs) {
	const loaded = controller.active?.captured.tools.get(name)?.renderResult;
	if (loaded) return loaded(...args);
	const [result, , theme] = args;
	const firstText = result.content.find((block) => block.type === "text")?.text ?? "";
	return new Text(theme.fg("toolOutput", firstText), 0, 0);
}

export const webAccessLazyBuiltinSpec: LazyBuiltinSpec = {
	label: "web-access",
	managedEvents: ["tool_result"],
	async register(pi, controller) {
		pi.on("tool_result", (event) => {
			if (isAllFailedWebResult(event.toolName, event.details)) return { isError: true };
		});

		controller.onSessionStart(async (_event, ctx) => {
			// Resumed sessions with stored web-access tool results load the lightweight wrapper so
			// custom result renderers format historical blocks immediately.
			try {
				if (hasWebAccessHistory(ctx.sessionManager.getEntries())) {
					await controller.activate(ctx);
				}
			} catch {
				// Partial context without sessionManager entries stays dormant.
			}
		});

		const shortcuts = await getInitialShortcutConfig();
		for (const [shortcut, name] of [
			[shortcuts.curate, "curate"],
			[shortcuts.activity, "activity"],
		] as const) {
			pi.registerShortcut(shortcut as KeyId, {
				description: name === "curate" ? "Open web search curator" : "Show web search activity",
				handler: (ctx) => controller.runShortcut(shortcut, ctx),
			});
		}

		pi.registerTool({
			name: "web_search",
			label: "Web Search",
			description:
				'Search the web using Perplexity AI, Exa, or Gemini. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Searches return raw results by default. Enable the interactive browser curator with /curator on or by setting workflow to "summary-review" in web-search config. Provider auto-selects: Exa (direct API with key, MCP fallback without), else Perplexity (needs key), else Gemini API (needs key), else Gemini Web (needs a supported Chromium-based browser login).',
			promptSnippet:
				"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
			parameters: Type.Object({
				query: Type.Optional(
					Type.String({
						description:
							"Single search query. For research tasks, prefer 'queries' with multiple varied angles instead.",
					}),
				),
				queries: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage.",
					}),
				),
				numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
				includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
				recencyFilter: Type.Optional(
					Type.String({ enum: ["day", "week", "month", "year"], description: "Filter by recency" }),
				),
				domainFilter: Type.Optional(
					Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" }),
				),
				provider: Type.Optional(
					Type.String({
						enum: ["auto", "perplexity", "gemini", "exa"],
						description: "Search provider (default: auto)",
					}),
				),
			}),
			execute: (...args) => controller.executeTool("web_search", args),
			renderResult: (...args) => renderResultFallback(controller, "web_search", args),
			renderCall(args, theme) {
				const input = args as { query?: string; queries?: string[] } | undefined;
				const list = Array.isArray(input?.queries)
					? input.queries.map((q) => String(q ?? "").trim()).filter(Boolean)
					: typeof input?.query === "string" && input.query.trim()
						? [input.query.trim()]
						: [];
				const label = list.join(" · ");
				return new Text(`${theme.fg("toolTitle", theme.bold("WebSearch"))}${theme.fg("text", `(${label})`)}`, 0, 0);
			},
		});

		pi.registerTool({
			name: "code_search",
			label: "Code Search",
			description:
				"Ask DeepWiki about code, architecture, and APIs in a public GitHub repository. Requires repoName in owner/repo format. No API key required; no web-search fallback.",
			promptSnippet:
				"Use for repository-specific programming questions. Supply repoName (owner/repo) and query; use web_search for broader discovery.",
			parameters: Type.Object({
				repoName: Type.String({
					pattern: "^[^\\s/]+/[^\\s/]+$",
					description: "Public GitHub repository in owner/repo format",
				}),
				query: Type.String({
					pattern: "\\S",
					description: "Question about the repository, sent verbatim to DeepWiki",
				}),
				maxTokens: Type.Optional(
					Type.Integer({
						minimum: 1000,
						maximum: 50000,
						description: "Best-effort output limit, approximately four characters per token (default: 5000)",
					}),
				),
			}),
			execute: (...args) => controller.executeTool("code_search", args),
			renderResult: (...args) => renderResultFallback(controller, "code_search", args),
			renderCall(args, theme) {
				const input = args as { repoName?: string; query?: string } | undefined;
				let text = theme.fg("toolTitle", theme.bold("code_search"));
				if (typeof input?.repoName === "string") text += ` ${theme.fg("accent", input.repoName)}`;
				if (typeof input?.query === "string") text += `\n${theme.fg("muted", input.query)}`;
				return new Text(text, 0, 0);
			},
		});

		pi.registerTool({
			name: "fetch_content",
			label: "Fetch Content",
			description:
				'Fetch webpages, PDFs, GitHub repositories, YouTube videos, or local video files. For ordinary pages, pass only {"urls":["https://example.com"]}; readable content is returned as markdown. For video analysis, include the user\'s question in prompt. Optional frames and timestamp extract images only from YouTube or local videos and are ignored for other inputs, including in mixed batches. Content is stored for get_search_content. Blocked or unreadable pages use extraction fallbacks.',
			promptSnippet:
				"Fetch webpages with urls only. For YouTube or local video analysis, include the user's question in prompt; omit frames and timestamp unless images are wanted.",
			parameters: Type.Object(
				{
					urls: Type.Array(Type.String({ minLength: 1 }), {
						minItems: 1,
						description:
							'URLs or local video paths to fetch. Always use an array, even for one URL: {"urls":["https://example.com"]}. Multiple URLs are fetched in parallel.',
					}),
					forceClone: Type.Optional(
						Type.Boolean({
							description:
								"GitHub repositories only: allow cloning above the configured size threshold. Omit for webpages and videos.",
						}),
					),
					prompt: Type.Optional(
						Type.String({
							description:
								"YouTube/local video analysis only: the user's specific question. Omit for webpages; this is not a webpage search or extraction filter.",
						}),
					),
					timestamp: Type.Optional(
						Type.String({
							description:
								"YouTube/local video images only: seconds ('85'), time ('1:25'), or range ('1:25-2:00'). Omit for text/transcripts. Ignored for non-video inputs. Ranges default to 6 frames; use frames to adjust.",
						}),
					),
					frames: Type.Optional(
						Type.Integer({
							minimum: 1,
							maximum: 12,
							description:
								"YouTube/local video images only: 1-12 frames. Alone, samples the whole video; with a range, samples that span; with a single timestamp, uses 5s intervals. Ignored for non-video inputs. Omit for text/transcripts. Requires ffmpeg, plus yt-dlp for YouTube.",
						}),
					),
					model: Type.Optional(
						Type.String({
							description:
								"Gemini model override for YouTube/local video analysis only. Omit to use the configured default; does not select the webpage extraction model.",
						}),
					),
				},
				{ additionalProperties: false },
			),
			execute: (...args) => controller.executeTool("fetch_content", args),
			renderResult: (...args) => renderResultFallback(controller, "fetch_content", args),
			renderCall(args, theme) {
				const input = args as { url?: string; urls?: string[] } | undefined;
				const urlList = Array.isArray(input?.urls) ? input.urls : typeof input?.url === "string" ? [input.url] : [];
				const label = urlList
					.map((u) =>
						String(u ?? "")
							.trim()
							.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""),
					)
					.filter(Boolean)
					.join(", ");
				return new Text(`${theme.fg("toolTitle", theme.bold("Fetch"))}${theme.fg("text", `(${label})`)}`, 0, 0);
			},
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
			execute: (...args) => controller.executeTool("get_search_content", args),
			renderResult: (...args) => renderResultFallback(controller, "get_search_content", args),
		});

		for (const [name, description] of [
			["websearch", "Configure web search"],
			["curator", "Configure web search curator"],
			["google-account", "Show the active Google account for Gemini Web"],
			["search", "Browse stored web search results"],
		] as const) {
			pi.registerCommand(name, {
				description,
				handler: (args, ctx) => controller.runCommand(name, args, ctx),
			});
		}
	},
};
