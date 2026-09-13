import type { ExtensionAPI, ExtensionContext, HandlerFn, MessageRenderer, RegisteredCommand, ToolDefinition } from "@bastani/atomic";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderWebAccessToolResult } from "./result-renderers.js";
import { assertCurrentLifecycleLease, createLifecycleLease, retainSettledLifecycleCleanup, retireLifecycleLease, type LifecycleLease } from "./lifecycle-lease.js";

type CapturedCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;
type CapturedShortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];
type ToolRenderResultArgs = Parameters<NonNullable<ToolDefinition["renderResult"]>>;
type CapturedHeavy = {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, CapturedCommand>;
	handlers: Map<string, HandlerFn[]>;
	shortcuts: Map<string, CapturedShortcut>;
};
type ShutdownSnapshot = { event: unknown; ctx: ExtensionContext; generation: number };
type WebLease = LifecycleLease<ShutdownSnapshot>;
type SessionSnapshot = {
	eventName: "session_start" | "session_tree";
	event: unknown;
	ctx: ExtensionContext;
	generation: number;
	lease: WebLease;
};
type HeavyHandle = { heavy: CapturedHeavy; assertCurrent: () => void };
type HeavyAttempt = { lease: WebLease; promise: Promise<HeavyHandle> };
type ReplayAttempt = { lease: WebLease; heavy: CapturedHeavy; promise: Promise<void> };

function addHandler(captured: CapturedHeavy, event: string, handler: HandlerFn): void {
	const handlers = captured.handlers.get(event) ?? [];
	handlers.push(handler);
	captured.handlers.set(event, handlers);
}

async function dispatchHandlers(captured: CapturedHeavy, eventName: string, event: unknown, ctx: ExtensionContext): Promise<void> {
	for (const handler of captured.handlers.get(eventName) ?? []) {
		await handler(event, ctx);
	}
}

function createHeavyProxy(pi: ExtensionAPI, captured: CapturedHeavy): ExtensionAPI {
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (tool: ToolDefinition) => {
					captured.tools.set(tool.name, tool);
				};
			}
			if (prop === "registerCommand") {
				return (name: string, options: CapturedCommand) => {
					captured.commands.set(name, options);
				};
			}
			if (prop === "on") {
				return (event: string, handler: HandlerFn) => {
					addHandler(captured, event, handler);
				};
			}
			if (prop === "registerShortcut") {
				return (shortcut: string, options: CapturedShortcut) => {
					captured.shortcuts.set(shortcut, options);
				};
			}
			if (prop === "registerMessageRenderer") {
				return (customType: string, renderer: MessageRenderer) => pi.registerMessageRenderer(customType, renderer);
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as ExtensionAPI;
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => reject(signal.reason));
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
		if (signal.aborted) onAbort();
	});
}

async function executeHeavyTool(
	loadHeavy: () => Promise<HeavyHandle>,
	name: string,
	args: Parameters<NonNullable<ToolDefinition["execute"]>>,
): Promise<Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>> {
	args[2]?.throwIfAborted();
	const handle = await waitForCaller(loadHeavy(), args[2]);
	args[2]?.throwIfAborted();
	handle.assertCurrent();
	const tool = handle.heavy.tools.get(name);
	if (!tool?.execute) throw new Error(`Web access tool implementation not found: ${name}`);
	let result: Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>;
	try {
		result = await tool.execute(...args);
	} catch (error) {
		args[2]?.throwIfAborted();
		throw error;
	}
	args[2]?.throwIfAborted();
	handle.assertCurrent();
	return result as Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>>;
}

async function runHeavyCommand(loadHeavy: () => Promise<HeavyHandle>, name: string, args: string | undefined, ctx: ExtensionContext): Promise<void> {
	const handle = await loadHeavy();
	handle.assertCurrent();
	const command = handle.heavy.commands.get(name);
	if (!command) throw new Error(`Web access command implementation not found: ${name}`);
	await command.handler(args, ctx);
	handle.assertCurrent();
}

function renderHeavyToolResult(loadedHeavy: CapturedHeavy | null, name: string, args: ToolRenderResultArgs): ReturnType<NonNullable<ToolDefinition["renderResult"]>> {
	const renderer = loadedHeavy?.tools.get(name)?.renderResult;
	if (renderer) return renderer(...args);
	return renderWebAccessToolResult(name, args);
}

function getInitialShortcutConfig(): { curate: string; activity: string } {
	const defaults = { curate: "ctrl+shift+s", activity: "ctrl+shift+w" };
	for (const configPath of [join(homedir(), ".atomic", "web-search.json"), join(homedir(), ".pi", "web-search.json")]) {
		try {
			if (!existsSync(configPath)) continue;
			const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { shortcuts?: { curate?: string; activity?: string } };
			return {
				curate: parsed.shortcuts?.curate?.trim() || defaults.curate,
				activity: parsed.shortcuts?.activity?.trim() || defaults.activity,
			};
		} catch (error) {
			console.error(`[pi-web-access] Failed to inspect shortcuts in ${configPath}:`, error);
		}
	}
	return defaults;
}

function isAllFailedWebResult(toolName: string, details: unknown): boolean {
	if (toolName !== "web_search" && toolName !== "fetch_content") return false;
	if (!details || typeof details !== "object") return false;
	return Reflect.get(details, "outcome") === "all_failed";
}

export default function webAccess(pi: ExtensionAPI) {
	let heavyAttempt: HeavyAttempt | null = null;
	let loadedHeavy: HeavyHandle | null = null;
	let sessionSnapshot: SessionSnapshot | null = null;
	let lifecycleGeneration = 0;
	let nextLeaseId = 1;
	let activeLease = createLifecycleLease<ShutdownSnapshot>(nextLeaseId++);
	let replayedGeneration = 0;
	let replayAttempt: ReplayAttempt | null = null;
	const invalidatedMessage = "Web access initialization was invalidated by session shutdown";

	function assertLease(lease: WebLease): void {
		assertCurrentLifecycleLease(activeLease, lease, invalidatedMessage);
	}

	function createHandle(heavy: CapturedHeavy, lease: WebLease): HeavyHandle {
		return { heavy, assertCurrent: () => assertLease(lease) };
	}

	async function waitForPriorCleanup(lease: WebLease): Promise<void> {
		await lease.priorCleanup;
		assertLease(lease);
	}

	async function replayCurrentSession(heavy: CapturedHeavy, lease: WebLease, onReplay?: (ctx: ExtensionContext) => void): Promise<void> {
		for (;;) {
			assertLease(lease);
			const snapshot = sessionSnapshot;
			if (!snapshot || snapshot.lease !== lease || replayedGeneration === snapshot.generation) return;
			onReplay?.(snapshot.ctx);
			await dispatchHandlers(heavy, snapshot.eventName, snapshot.event, snapshot.ctx);
			assertLease(lease);
			if (sessionSnapshot === snapshot) {
				replayedGeneration = snapshot.generation;
				return;
			}
		}
	}

	async function ensureCurrentSessionReplayed(heavy: CapturedHeavy, lease: WebLease, onReplay?: (ctx: ExtensionContext) => void): Promise<void> {
		await waitForPriorCleanup(lease);
		const snapshot = sessionSnapshot;
		if (!snapshot || snapshot.lease !== lease || replayedGeneration === snapshot.generation) return;
		const existing = replayAttempt;
		if (existing?.lease === lease && existing.heavy === heavy) return existing.promise;
		let promise: Promise<void>;
		promise = replayCurrentSession(heavy, lease, onReplay).finally(() => {
			if (replayAttempt?.promise === promise) replayAttempt = null;
		});
		replayAttempt = { lease, heavy, promise };
		await promise;
	}

	async function loadHeavy(): Promise<HeavyHandle> {
		const lease = activeLease;
		if (lease.retired) throw new Error("Web access initialization unavailable: no active session");
		await waitForPriorCleanup(lease);
		const existing = heavyAttempt;
		if (existing?.lease === lease) {
			const handle = await existing.promise;
			assertLease(lease);
			await ensureCurrentSessionReplayed(handle.heavy, lease);
			assertLease(lease);
			return handle;
		}
		let promise: Promise<HeavyHandle>;
		promise = (async (): Promise<HeavyHandle> => {
			const captured: CapturedHeavy = { tools: new Map(), commands: new Map(), handlers: new Map(), shortcuts: new Map() };
			let replayCtx: ExtensionContext | null = null;
			let cleaned = false;
			const cleanupCandidate = async (): Promise<void> => {
				const shutdown = lease.shutdown;
				const cleanupCtx = shutdown?.ctx ?? replayCtx;
				if (!cleanupCtx || cleaned) return;
				cleaned = true;
				try {
					await dispatchHandlers(captured, "session_shutdown", shutdown?.event ?? { type: "session_shutdown", reason: "quit" }, cleanupCtx);
				} catch (cleanupError) {
					console.error("[pi-web-access] Failed to clean rejected lazy candidate:", cleanupError);
				}
			};
			try {
				const mod = await import("./index-heavy.js");
				assertLease(lease);
				await mod.default(createHeavyProxy(pi, captured));
				assertLease(lease);
				await ensureCurrentSessionReplayed(captured, lease, (ctx) => { replayCtx = ctx; });
				assertLease(lease);
				const handle = createHandle(captured, lease);
				loadedHeavy = handle;
				return handle;
			} catch (error) {
				await cleanupCandidate();
				throw error;
			}
		})();
		heavyAttempt = { lease, promise };
		void promise.then(
			() => undefined,
			() => { if (heavyAttempt?.promise === promise) heavyAttempt = null; },
		);
		return promise;
	}

	pi.on("session_start", async (event, ctx) => {
		if (activeLease.retired) activeLease = createLifecycleLease<ShutdownSnapshot>(nextLeaseId++, activeLease.cleanupBarrier);
		const lease = activeLease;
		await waitForPriorCleanup(lease);
		const generation = ++lifecycleGeneration;
		sessionSnapshot = { eventName: "session_start", event, ctx, generation, lease };
		if (loadedHeavy) await ensureCurrentSessionReplayed(loadedHeavy.heavy, lease);
	});

	pi.on("session_tree", async (event, ctx) => {
		const lease = activeLease;
		if (lease.retired) return;
		await lease.priorCleanup;
		if (activeLease !== lease || lease.retired) return;
		const generation = ++lifecycleGeneration;
		sessionSnapshot = { eventName: "session_tree", event, ctx, generation, lease };
		if (loadedHeavy) await ensureCurrentSessionReplayed(loadedHeavy.heavy, lease);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const lease = activeLease;
		const generation = ++lifecycleGeneration;
		const shutdown = { event, ctx, generation };
		retireLifecycleLease(lease, shutdown);
		const retiredHeavy = loadedHeavy?.heavy ?? null;
		const retiredAttempt = heavyAttempt?.lease === lease ? heavyAttempt.promise : null;
		const retiredReplay = replayAttempt?.lease === lease ? replayAttempt.promise : null;
		sessionSnapshot = null;
		heavyAttempt = null;
		loadedHeavy = null;
		replayAttempt = null;
		replayedGeneration = generation;
		const publishedCleanup = retiredHeavy
			? dispatchHandlers(retiredHeavy, "session_shutdown", event, ctx)
			: Promise.resolve();
		const retainedCleanup = retainSettledLifecycleCleanup(lease, [publishedCleanup, retiredAttempt, retiredReplay]);
		try {
			await publishedCleanup;
		} finally {
			await retainedCleanup;
		}
	});

	pi.on("tool_result", (event) => {
		if (isAllFailedWebResult(event.toolName, event.details)) return { isError: true };
	});

	const shortcuts = getInitialShortcutConfig();
	for (const [shortcut, name] of [[shortcuts.curate, "curate"], [shortcuts.activity, "activity"]] as const) {
		pi.registerShortcut(shortcut, {
			description: name === "curate" ? "Open web search curator" : "Show web search activity",
			handler: async (ctx) => {
				const handle = await loadHeavy();
				handle.assertCurrent();
				const handler = handle.heavy.shortcuts.get(shortcut)?.handler;
				if (!handler) throw new Error(`Web access shortcut implementation not found: ${shortcut}`);
				await handler(ctx);
				handle.assertCurrent();
			},
		});
	}

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using Perplexity AI, Exa, or Gemini. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Searches return raw results by default. Enable the interactive browser curator with /curator on or by setting workflow to \"summary-review\" in web-search config. Provider auto-selects: Exa (direct API with key, MCP fallback without), else Perplexity (needs key), else Gemini API (needs key), else Gemini Web (needs a supported Chromium-based browser login).",
		promptSnippet: "Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage." })),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(Type.String({ enum: ["day", "week", "month", "year"], description: "Filter by recency" })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			provider: Type.Optional(Type.String({ enum: ["auto", "perplexity", "gemini", "exa"], description: "Search provider (default: auto)" })),
		}),
		execute: (...args) => executeHeavyTool(loadHeavy, "web_search", args),
		renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "web_search", args),
		renderCall(args, theme) {
			const input = args as { query?: string; queries?: string[] };
			const label = input.queries?.length ? `${input.queries.length} queries` : input.query ?? "(no query)";
			return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", label), 0, 0);
		},
	});

	pi.registerTool({
		name: "code_search",
		label: "Code Search",
		description: "Ask DeepWiki about code, architecture, and APIs in a public GitHub repository. Requires repoName in owner/repo format. No API key required; no web-search fallback.",
		promptSnippet: "Use for repository-specific programming questions. Supply repoName (owner/repo) and query; use web_search for broader discovery.",
		parameters: Type.Object({
			repoName: Type.String({ pattern: "^[^\\s/]+/[^\\s/]+$", description: "Public GitHub repository in owner/repo format" }),
			query: Type.String({ pattern: "\\S", description: "Question about the repository, sent verbatim to DeepWiki" }),
			maxTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, description: "Best-effort output limit, approximately four characters per token (default: 5000)" })),
		}),
		execute: (...args) => executeHeavyTool(loadHeavy, "code_search", args),
		renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "code_search", args),
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: 'Fetch webpages, PDFs, GitHub repositories, YouTube videos, or local video files. For ordinary pages, pass only {"urls":["https://example.com"]}; readable content is returned as markdown. For video analysis, include the user\'s question in prompt. Optional frames and timestamp extract images only from YouTube or local videos and are ignored for other inputs, including in mixed batches. Content is stored for get_search_content. Blocked or unreadable pages use extraction fallbacks.',
		promptSnippet: "Fetch webpages with urls only. For YouTube or local video analysis, include the user's question in prompt; omit frames and timestamp unless images are wanted.",
		parameters: Type.Object({
			urls: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description: 'URLs or local video paths to fetch. Always use an array, even for one URL: {"urls":["https://example.com"]}. Multiple URLs are fetched in parallel.',
			}),
			forceClone: Type.Optional(Type.Boolean({ description: "GitHub repositories only: allow cloning above the configured size threshold. Omit for webpages and videos." })),
			prompt: Type.Optional(Type.String({ description: "YouTube/local video analysis only: the user's specific question. Omit for webpages; this is not a webpage search or extraction filter." })),
			timestamp: Type.Optional(Type.String({ description: "YouTube/local video images only: seconds ('85'), time ('1:25'), or range ('1:25-2:00'). Omit for text/transcripts. Ignored for non-video inputs. Ranges default to 6 frames; use frames to adjust." })),
			frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "YouTube/local video images only: 1-12 frames. Alone, samples the whole video; with a range, samples that span; with a single timestamp, uses 5s intervals. Ignored for non-video inputs. Omit for text/transcripts. Requires ffmpeg, plus yt-dlp for YouTube." })),
			model: Type.Optional(Type.String({ description: "Gemini model override for YouTube/local video analysis only. Omit to use the configured default; does not select the webpage extraction model." })),
		}, { additionalProperties: false }),
		execute: (...args) => executeHeavyTool(loadHeavy, "fetch_content", args),
		renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "fetch_content", args),
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve full content from a previous web_search or fetch_content call.",
		promptSnippet: "Use after web_search/fetch_content when full stored content is needed via responseId plus query/url selectors.",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
			query: Type.Optional(Type.String({ description: "Get content for this query (web_search)" })),
			queryIndex: Type.Optional(Type.Number({ description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Number({ description: "Get content for URL at index" })),
		}),
		execute: (...args) => executeHeavyTool(loadHeavy, "get_search_content", args),
		renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "get_search_content", args),
	});

	for (const [name, description] of [
		["websearch", "Configure web search"],
		["curator", "Configure web search curator"],
		["google-account", "Show the active Google account for Gemini Web"],
		["search", "Browse stored web search results"],
	] as const) {
		pi.registerCommand(name, {
			description,
			handler: (args, ctx) => runHeavyCommand(loadHeavy, name, args, ctx),
		});
	}
}
