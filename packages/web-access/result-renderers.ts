import type { ToolDefinition } from "@bastani/atomic";
import { Box, Text } from "@mariozechner/pi-tui";
import { formatSeconds } from "./utils.js";

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
	urlCount?: number;
	successful?: number;
	totalChars?: number;
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
	return result.content.find(isTextContentBlock)?.text ?? "";
}

function progressBar(progress: number): string {
	const filled = Math.floor(progress * 10);
	return "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
}

export const renderWebSearchResult: ToolResultRenderer = (result, { expanded, isPartial }, theme) => {
	const details = result.details as WebSearchResultDetails | undefined;

	if (isPartial) {
		if (details?.phase === "curating") {
			return new Text(theme.fg("accent", "waiting for summary approval..."), 0, 0);
		}
		if (details?.phase === "searching") {
			const progress = details?.progress ?? 0;
			const bar = progressBar(progress);
			const query = details?.currentQuery || "";
			const display = query.length > 40 ? query.slice(0, 37) + "..." : query;
			return new Text(theme.fg("accent", `[${bar}] ${display}`), 0, 0);
		}
		const progress = details?.progress ?? 0;
		const bar = progressBar(progress);
		return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "searching"}`), 0, 0);
	}

	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	let statusLine: string;
	const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
	statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
	if (details?.curated && details?.curatedFrom) {
		statusLine += theme.fg("muted", ` (${details.queryCount}/${details.curatedFrom} queries curated)`);
	}
	if (details?.fetchId && details?.fetchUrls) {
		statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
	} else if (details?.fetchId) {
		statusLine += theme.fg("muted", " (content ready)");
	}

	// Build expanded lines first so collapsed view can reference total count
	const lines = [statusLine];
	if (details?.summary?.text) {
		lines.push("");
		lines.push(theme.fg("accent", `── Summary (${details.summary.workflow}) ` + "─".repeat(32)));
		lines.push("");
		for (const line of details.summary.text.split("\n")) {
			lines.push(`  ${line}`);
		}
		lines.push("");
		const metaParts = [
			details.summary.model ? `model=${details.summary.model}` : "model=deterministic",
			`duration=${details.summary.durationMs}ms`,
			`tokens~${details.summary.tokenEstimate}`,
			details.summary.fallbackUsed ? "fallback=true" : "fallback=false",
			details.summary.edited ? "edited=true" : "edited=false",
		];
		if (details.summary.fallbackReason) {
			metaParts.push(`reason=${details.summary.fallbackReason}`);
		}
		lines.push(theme.fg("dim", "  " + metaParts.join(" · ")));
	}

	const queryDetails = details?.curatedQueries;
	if (queryDetails?.length) {
		const kept = queryDetails.length;
		const from = details?.curatedFrom ?? kept;
		lines.push("");
		lines.push(theme.fg("accent", `\u2500\u2500 Curated Results (${kept} of ${from} queries kept) ` + "\u2500".repeat(24)));

		for (const cq of queryDetails) {
			lines.push("");
			const dq = cq.query.length > 65 ? cq.query.slice(0, 62) + "..." : cq.query;
			const providerLabel = cq.provider ? ` (${cq.provider})` : "";
			lines.push(theme.fg("accent", `  "${dq}"${providerLabel}`));

			if (cq.error) {
				lines.push(theme.fg("error", `  ${cq.error}`));
			} else if (cq.answer) {
				lines.push("");
				for (const line of cq.answer.split("\n")) {
					lines.push(`  ${line}`);
				}
			}

			if (cq.sources.length > 0) {
				lines.push("");
				for (const s of cq.sources) {
					const domain = s.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
					const title = s.title.length > 50 ? s.title.slice(0, 47) + "..." : s.title;
					lines.push(theme.fg("muted", `  \u25b8 ${title}`) + theme.fg("dim", ` \u00b7 ${domain}`));
				}
			}
		}
		lines.push("");
	} else {
		const textContent = firstTextContent(result);
		const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
		for (const line of preview.split("\n")) {
			lines.push(theme.fg("dim", line));
		}
	}

	if (details?.fetchUrls && details.fetchUrls.length > 0) {
		if (details.curated) {
			lines.push(theme.fg("muted", `Fetching ${details.fetchUrls.length} URLs in background`));
		} else {
			lines.push(theme.fg("muted", "Fetching:"));
			for (const u of details.fetchUrls.slice(0, 5)) {
				const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
				lines.push(theme.fg("dim", "  " + display));
			}
			if (details.fetchUrls.length > 5) {
				lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
			}
		}
	}

	const totalLines = lines.length;

	if (!expanded) {
		const box = new Box(1, 0, (t) => theme.bg("toolSuccessBg", t));
		box.addChild(new Text(statusLine, 0, 0));

		let collapsedLines = 1; // statusLine
		const summaryPreview = details?.summary?.text?.trim() || "";
		if (summaryPreview) {
			const preview = summaryPreview.length > 120 ? summaryPreview.slice(0, 117) + "..." : summaryPreview;
			box.addChild(new Text(theme.fg("dim", preview), 0, 0));
			collapsedLines++;
		} else if (details?.curatedQueries?.length) {
			for (const cq of details.curatedQueries.slice(0, 3)) {
				const dq = cq.query.length > 55 ? cq.query.slice(0, 52) + "..." : cq.query;
				const srcCount = cq.sources?.length ?? 0;
				const suffix = cq.error ? theme.fg("error", " (error)") : theme.fg("dim", ` · ${srcCount} sources`);
				box.addChild(new Text(theme.fg("accent", `  "${dq}"`) + suffix, 0, 0));
				collapsedLines++;
			}
			if (details.curatedQueries.length > 3) {
				box.addChild(new Text(theme.fg("dim", `  ... and ${details.curatedQueries.length - 3} more`), 0, 0));
				collapsedLines++;
			}
		} else {
			const textContent = firstTextContent(result);
			const firstContentLine = textContent.split("\n").find(l => {
				const t = l.trim();
				return t && !t.startsWith("[") && !t.startsWith("#") && !t.startsWith("---");
			});
			const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
			if (fallbackLine) {
				const preview = fallbackLine.length > 120 ? fallbackLine.slice(0, 117) + "..." : fallbackLine;
				box.addChild(new Text(theme.fg("dim", preview), 0, 0));
				collapsedLines++;
			}
		}
		const moreLines = Math.max(0, totalLines - collapsedLines);
		if (moreLines > 0) {
			box.addChild(new Text(theme.fg("muted", `\n... (${moreLines} more lines, ${totalLines} total, CTRL+O Expand)`), 0, 0));
		}
		return box;
	}

	return new Text(lines.join("\n"), 0, 0);
};

export const renderCodeSearchResult: ToolResultRenderer = (result, { expanded }, theme) => {
	const details = result.details as CodeSearchResultDetails | undefined;
	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	const summary = theme.fg("success", "code context returned") +
		theme.fg("muted", ` (${details?.maxTokens ?? 5000} tokens max)`);
	if (!expanded) return new Text(summary, 0, 0);

	const textContent = firstTextContent(result);
	const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
	return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
};

export const renderFetchContentResult: ToolResultRenderer = (result, { expanded, isPartial }, theme) => {
	const details = result.details as FetchContentResultDetails | undefined;

	if (isPartial) {
		const progress = details?.progress ?? 0;
		const bar = progressBar(progress);
		return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
	}

	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	if (details?.urlCount === 1) {
		const title = details?.title || "Untitled";
		const imgCount = details?.imageCount ?? (details?.hasImage ? 1 : 0);
		const imageBadge = imgCount > 1
			? theme.fg("accent", ` [${imgCount} images]`)
			: imgCount === 1
				? theme.fg("accent", " [image]")
				: "";
		let statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`) + imageBadge;
		if (details?.truncated) {
			statusLine += theme.fg("warning", " [truncated]");
		}
		if (typeof details?.duration === "number") {
			statusLine += theme.fg("muted", ` | ${formatSeconds(Math.floor(details.duration))} total`);
		}
		const textContent = firstTextContent(result);
		if (!expanded) {
			const brief = textContent.length > 200 ? textContent.slice(0, 200) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", brief), 0, 0);
		}
		const lines = [statusLine];
		if (details?.prompt) {
			const display = details.prompt.length > 250 ? details.prompt.slice(0, 247) + "..." : details.prompt;
			lines.push(theme.fg("dim", `  prompt: "${display}"`));
		}
		if (details?.timestamp) {
			lines.push(theme.fg("dim", `  timestamp: ${details.timestamp}`));
		}
		if (typeof details?.frames === "number") {
			lines.push(theme.fg("dim", `  frames: ${details.frames}`));
		}
		const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
		lines.push(theme.fg("dim", preview));
		return new Text(lines.join("\n"), 0, 0);
	}

	const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
	const statusLine = theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", " (content stored)");
	if (!expanded) {
		return new Text(statusLine, 0, 0);
	}
	const textContent = firstTextContent(result);
	const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
	return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
};

export const renderGetSearchContentResult: ToolResultRenderer = (result, { expanded }, theme) => {
	const details = result.details as GetSearchContentResultDetails | undefined;

	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	let statusLine: string;
	if (details?.query) {
		statusLine = theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount} results)`);
	} else {
		statusLine = theme.fg("success", details?.title || "Content") + theme.fg("muted", ` (${details?.contentLength ?? 0} chars)`);
	}

	if (!expanded) {
		return new Text(statusLine, 0, 0);
	}

	const textContent = firstTextContent(result);
	const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
	return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
};

export function renderWebAccessToolResult(name: string, args: ToolRenderResultArgs): ToolRenderResult {
	switch (name) {
		case "web_search":
			return renderWebSearchResult(...args);
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
