import {
	collapseToolBlockLines,
	TOOL_BLOCK_LIMITS,
	type ToolDefinition,
	terminalDisplayText,
} from "@bastani/atomic";
import { Text } from "@bastani/atomic-tui";

type ToolResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
type ToolRenderResultArgs = Parameters<ToolResultRenderer>;
type ToolRenderResult = ReturnType<ToolResultRenderer>;
type RenderedResult = ToolRenderResultArgs[0];
type TextContentBlock = Extract<RenderedResult["content"][number], { type: "text" }>;

type QueryDetail = {
	query: string;
	provider: string | null;
	answer: string | null;
	sources: Array<{ title: string; url: string }>;
	error: string | null;
};

type WebSearchResultDetails = {
	queryCount?: number;
	successfulQueries?: number;
	totalResults?: number;
	error?: string;
	fetchId?: string;
	fetchUrls?: string[];
	phase?: string;
	progress?: number;
	currentQuery?: string;
	curated?: boolean;
	curatedFrom?: number;
	curatedQueries?: QueryDetail[];
	cancelled?: boolean;
	cancelReason?: string;
	sources?: Array<{ title?: string; url?: string; host?: string; domain?: string }>;
	results?: Array<{ title?: string; url?: string; host?: string; domain?: string }>;
	summary?: {
		text: string;
		workflow: "summary-review";
		model: string | null;
		durationMs: number;
		tokenEstimate: number;
		fallbackUsed: boolean;
		fallbackReason?: string;
		edited?: boolean;
	};
};

type CodeSearchResultDetails = {
	query?: string;
	maxTokens?: number;
	error?: string;
};

type FetchContentResultDetails = {
	urls?: string[];
	urlCount?: number;
	successful?: number;
	totalChars?: number;
	bytes?: number;
	sizeBytes?: number;
	format?: string;
	error?: string;
	title?: string;
	truncated?: boolean;
	responseId?: string;
	phase?: string;
	progress?: number;
	hasImage?: boolean;
	imageCount?: number;
	prompt?: string;
	timestamp?: string;
	frames?: number;
	duration?: number;
	outcome?: string;
};

type GetSearchContentResultDetails = {
	error?: string;
	query?: string;
	url?: string;
	title?: string;
	resultCount?: number;
	contentLength?: number;
};

function isTextContentBlock(block: RenderedResult["content"][number]): block is TextContentBlock {
	return block.type === "text";
}

function firstTextContent(result: RenderedResult): string {
	return terminalDisplayText(result.content.find(isTextContentBlock)?.text ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "");
}

function singleLine(value: string): string {
	return terminalDisplayText(value).replace(/\s+/gu, " ").trim();
}

function stripUrlScheme(rawUrl: string): string {
	return singleLine(rawUrl).replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}

function extractHost(rawUrl: string): string {
	const cleaned = singleLine(rawUrl);
	if (!cleaned) return "";
	try {
		return new URL(cleaned).hostname.replace(/^www\./i, "");
	} catch {
		return stripUrlScheme(cleaned).replace(/\/.*$/, "").replace(/^www\./i, "");
	}
}

function formatByteSize(bytes: number): string {
	const safe = Math.max(0, Math.floor(bytes));
	if (safe < 1024) return `${safe} B`;
	if (safe < 1024 * 1024) {
		const kb = Math.round((safe / 1024) * 10) / 10;
		return `${Number.isInteger(kb) ? kb.toFixed(0) : kb.toFixed(1)} KB`;
	}
	const mb = Math.round((safe / (1024 * 1024)) * 10) / 10;
	return `${Number.isInteger(mb) ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

function parseSources(
	rawText: string,
	details: WebSearchResultDetails | undefined,
): Array<{ title: string; host: string }> {
	const sources: Array<{ title: string; host: string }> = [];
	const seen = new Set<string>();
	const add = (title: string, urlOrHost: string) => {
		const cleanTitle = singleLine(title);
		const host = extractHost(urlOrHost);
		if (!cleanTitle) return;
		const key = `${cleanTitle}::${host}`;
		if (seen.has(key)) return;
		seen.add(key);
		sources.push({ title: cleanTitle, host });
	};

	const direct = details?.sources ?? details?.results;
	if (Array.isArray(direct)) {
		for (const item of direct) {
			if (item?.title) add(item.title, item.url ?? item.host ?? item.domain ?? "");
		}
	}

	if (Array.isArray(details?.curatedQueries)) {
		for (const cq of details.curatedQueries) {
			for (const s of cq.sources ?? []) {
				if (s?.title) add(s.title, s.url ?? "");
			}
		}
	}

	if (sources.length === 0 && rawText) {
		const numberedPattern = /^\d+\.\s+(\S[^\n]*)\n\s+(https?:\/\/\S+)/gm;
		for (let match = numberedPattern.exec(rawText); match !== null; match = numberedPattern.exec(rawText)) {
			add(match[1]!, match[2]!);
		}
	}

	if (sources.length === 0 && rawText) {
		const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
		for (let match = linkPattern.exec(rawText); match !== null; match = linkPattern.exec(rawText)) {
			add(match[1]!, match[2]!);
		}
	}

	return sources;
}

export const renderWebSearchResult = ((result, { expanded, isPartial }, theme) => {
	const details = result.details as WebSearchResultDetails | undefined;

	if (isPartial) {
		if (details?.phase === "curating") {
			return new Text(theme.fg("muted", "Waiting for summary approval…"), 0, 0);
		}
		if (details?.currentQuery) {
			return new Text(theme.fg("muted", `Searching ${singleLine(details.currentQuery)}…`), 0, 0);
		}
		return new Text("", 0, 0);
	}

	if (details?.error) {
		const cleanErr = singleLine(details.error).replace(/^Error:\s*/i, "");
		return new Text(theme.fg("error", cleanErr), 0, 0);
	}

	const rawText = firstTextContent(result);
	const sources = parseSources(rawText, details);
	const totalResults = typeof details?.totalResults === "number" ? details.totalResults : sources.length;
	const summaryLine = theme.fg(
		"text",
		`${theme.bold(String(totalResults))} ${totalResults === 1 ? "result" : "results"}`,
	);

	if (sources.length > 0) {
		const sourceRows = sources.map((source) =>
			source.host
				? `${theme.fg("toolOutput", source.title)}${theme.fg("dim", ` · ${source.host}`)}`
				: theme.fg("toolOutput", source.title),
		);
		if (!expanded) {
			const collapsed = collapseToolBlockLines(sourceRows, TOOL_BLOCK_LIMITS.web, false);
			return new Text([summaryLine, ...collapsed].join("\n"), 0, 0);
		}
		const extraLines = rawText
			.split("\n")
			.map((line) => line.trimEnd())
			.filter(
				(line) =>
					line.trim() !== "" &&
					line.trim() !== "---" &&
					line.trim() !== "**Sources:**" &&
					!/^\d+\.\s+/.test(line.trim()) &&
					!/^https?:\/\/\S+$/.test(line.trim()),
			)
			.map((line) => theme.fg("toolOutput", line));
		return new Text([summaryLine, ...sourceRows, ...extraLines].join("\n"), 0, 0);
	}

	const fallbackRows = rawText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && line !== "---" && !line.startsWith("[") && line !== "No results found.")
		.map((line) => theme.fg("toolOutput", line));

	if (fallbackRows.length === 0) {
		return new Text(summaryLine, 0, 0);
	}

	const collapsed = collapseToolBlockLines(fallbackRows, TOOL_BLOCK_LIMITS.web, expanded);
	return new Text([summaryLine, ...collapsed].join("\n"), 0, 0);
}) satisfies ToolResultRenderer;

export const renderCodeSearchResult: ToolResultRenderer = (result, { expanded }, theme) => {
	const details = result.details as CodeSearchResultDetails | undefined;
	if (details?.error) {
		return new Text(theme.fg("error", singleLine(details.error).replace(/^Error:\s*/i, "")), 0, 0);
	}

	const summary =
		theme.fg("text", "DeepWiki answer returned") +
		theme.fg("dim", ` · ~${details?.maxTokens ?? 5000} tokens max`);
	if (!expanded) return new Text(summary, 0, 0);

	const textContent = firstTextContent(result);
	const lines = textContent
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => theme.fg("toolOutput", line));
	return new Text([summary, ...lines].join("\n"), 0, 0);
};

export const renderFetchContentResult: ToolResultRenderer = (result, { expanded, isPartial }, theme) => {
	const details = result.details as FetchContentResultDetails | undefined;

	if (isPartial) {
		return new Text("", 0, 0);
	}

	if (details?.error || details?.outcome === "all_failed") {
		const rawError = details?.error || firstTextContent(result) || "Fetch failed";
		const firstLine = singleLine(rawError.split("\n")[0] ?? rawError).replace(/^Error:\s*/i, "");
		return new Text(theme.fg("error", firstLine), 0, 0);
	}

	const rawText = firstTextContent(result);
	const bytes =
		details?.bytes ??
		details?.sizeBytes ??
		details?.totalChars ??
		Buffer.byteLength(rawText, "utf8");
	const firstUrl = details?.urls?.[0] ?? "";
	const format =
		details?.format ??
		(details?.frames !== undefined || details?.timestamp !== undefined || typeof details?.duration === "number"
			? "video"
			: /\.pdf(?:$|[?#])/i.test(firstUrl)
				? "pdf"
				: "markdown");

	const summaryLine = `${theme.fg("text", `Fetched ${theme.bold(formatByteSize(bytes))}`)}${theme.fg("dim", ` · ${format}`)}`;
	if (!expanded) {
		return new Text(summaryLine, 0, 0);
	}

	const bodyLines = rawText
		.replace(/\n+$/, "")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => theme.fg("toolOutput", line));
	return new Text([summaryLine, ...bodyLines].join("\n"), 0, 0);
};

export const renderGetSearchContentResult: ToolResultRenderer = (result, { expanded }, theme) => {
	const details = result.details as GetSearchContentResultDetails | undefined;

	if (details?.error) {
		return new Text(theme.fg("error", singleLine(details.error).replace(/^Error:\s*/i, "")), 0, 0);
	}

	let statusLine: string;
	if (details?.query) {
		const count = details.resultCount ?? 0;
		statusLine = theme.fg("text", `${theme.bold(String(count))} ${count === 1 ? "result" : "results"}`);
	} else {
		const bytes = details?.contentLength ?? 0;
		statusLine = `${theme.fg("text", `Fetched ${theme.bold(formatByteSize(bytes))}`)}${theme.fg("dim", " · markdown")}`;
	}

	if (!expanded) {
		return new Text(statusLine, 0, 0);
	}

	const textContent = firstTextContent(result);
	const lines = textContent
		.replace(/\n+$/, "")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => theme.fg("toolOutput", line));
	return new Text([statusLine, ...lines].join("\n"), 0, 0);
};

export function renderWebAccessToolResult(name: string, args: ToolRenderResultArgs): ToolRenderResult {
	switch (name) {
		case "web_search":
			return renderWebSearchResult(args[0], args[1], args[2]);
		case "code_search":
			return renderCodeSearchResult(...args);
		case "fetch_content":
			return renderFetchContentResult(...args);
		case "get_search_content":
			return renderGetSearchContentResult(...args);
		default: {
			const theme = args[2];
			return new Text(theme.fg("error", `Result renderer not found: ${name}`), 0, 0);
		}
	}
}
