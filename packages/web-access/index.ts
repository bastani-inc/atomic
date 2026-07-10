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
		description: "Search the web using Perplexity AI, Exa, or Gemini. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Searches auto-open the interactive browser curator and stream results live; set workflow to \"none\" to skip curation. Provider auto-selects: Exa (direct API with key, MCP fallback without), else Perplexity (needs key), else Gemini API (needs key), else Gemini Web (needs a supported Chromium-based browser login).",
		promptSnippet: "Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage." })),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(Type.String({ enum: ["day", "week", "month", "year"], description: "Filter by recency" })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			provider: Type.Optional(Type.String({ enum: ["auto", "perplexity", "gemini", "exa"], description: "Search provider (default: auto)" })),
			workflow: Type.Optional(Type.String({ enum: ["none", "summary-review"], description: "Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default)" })),
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
		description: "Search for code examples, documentation, and API references. Returns relevant code snippets and docs from GitHub, Stack Overflow, and official documentation. Use for any programming question — API usage, library examples, debugging help.",
		promptSnippet: "Use for programming/API/library questions to retrieve concrete examples and docs before implementing or debugging code.",
		parameters: Type.Object({
			query: Type.String({ description: "Programming question, API, library, or debugging topic to search for" }),
			maxTokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 50000, description: "Maximum tokens of code/documentation context to return (default: 5000)" })),
		}),
		execute: (...args) => executeHeavyTool(loadHeavy, "code_search", args),
		renderResult: (...args) => renderHeavyToolResult(loadedHeavy?.heavy ?? null, "code_search", args),
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch URL(s) and extract readable content as markdown. Supports YouTube video transcripts (with thumbnail), GitHub repository contents, and local video files (with frame thumbnail). Video frames can be extracted via timestamp/range or sampled across the entire video with frames alone. Falls back to Gemini for pages that block bots or fail Readability extraction. For YouTube and video files: ALWAYS pass the user's specific question via the prompt parameter — this directs the AI to focus on that aspect of the video, producing much better results than a generic extraction. Content is always stored and can be retrieved with get_search_content.",
		promptSnippet: "Use to extract readable content from URL(s), YouTube, GitHub repos, or local videos. For video questions, pass the user's exact question in prompt.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			forceClone: Type.Optional(Type.Boolean({ description: "Force cloning large GitHub repositories that exceed the size threshold" })),
			prompt: Type.Optional(Type.String({ description: "Question or instruction for video analysis (YouTube and video files)." })),
			timestamp: Type.Optional(Type.String({ description: "Extract video frame(s) at a timestamp or time range." })),
			frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "Number of frames to extract." })),
			model: Type.Optional(Type.String({ description: "Override the Gemini model for video/YouTube analysis." })),
		}),
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
