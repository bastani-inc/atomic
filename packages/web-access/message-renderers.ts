import {
	collapseToolBlockLines,
	type ExtensionAPI,
	type MessageRenderer,
	type Theme,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockMarkdown,
	ToolBlockRecords,
	terminalDisplayText,
} from "@bastani/atomic";
import { type Component, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";

const CONTENT_READY_RE = /^Content fetched for (\d+)\/(\d+) URLs \[([^\]]+)\]/;
const CONTENT_ERROR_RE = /^Content fetch failed \[([^\]]+)\]:\s*([\s\S]+)$/;

function cleanOneLine(value: string): string {
	return terminalDisplayText(value)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

function cleanMultiline(value: string): string {
	return terminalDisplayText(value)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ")
		.trim();
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			if (!part || typeof part !== "object") return false;
			const block = part as { type?: unknown; text?: unknown };
			return block.type === "text" && typeof block.text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

function wrappedRecord(text: string, style: (line: string) => string): Component {
	return {
		invalidate(): void {},
		render(width: number): string[] {
			if (width < 1) return [];
			const lines: string[] = [];
			for (const rawLine of text.split("\n")) {
				const wrapped = wrapTextWithAnsi(style(rawLine), width);
				lines.push(...(wrapped.length > 0 ? wrapped : [""]));
			}
			return lines;
		},
	};
}

function titleWithTruncatedMeta(titleStyled: string, metaText: string | undefined, theme: Theme): Component {
	return {
		invalidate(): void {},
		render(width: number): string[] {
			if (width < 1) return [];
			const titleW = visibleWidth(titleStyled);
			if (!metaText || titleW + 4 >= width) {
				return [truncateToWidth(titleStyled, width, "…")];
			}
			const room = width - titleW - 3;
			const shown = visibleWidth(metaText) <= room ? metaText : truncateToWidth(metaText, room, "…");
			return [`${titleStyled}${theme.fg("dim", ` · ${shown}`)}`];
		},
	};
}

class ReplayableBlock implements Component {
	readonly historyReplayable = true;
	private readonly inner: Component;

	constructor(inner: Component) {
		this.inner = inner;
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	render(width: number): string[] {
		return this.inner.render(width);
	}
}

export const renderCuratorConfigMessage: MessageRenderer = (message, options, theme) => {
	const details =
		message.details && typeof message.details === "object"
			? (message.details as { readonly workflow?: unknown })
			: undefined;
	const rawMultiline = cleanMultiline(messageText(message.content));
	const workflow = details?.workflow;
	const title =
		workflow === "none"
			? "Search curator disabled"
			: workflow === "summary-review"
				? "Search curator enabled"
				: cleanOneLine(rawMultiline) || "Search curator updated";
	const meta =
		workflow === "none"
			? "web_search returns raw results"
			: workflow === "summary-review"
				? "web_search opens curator with summary draft"
				: undefined;
	return new ReplayableBlock(
		new ToolBlock({
			status: "info",
			title: titleWithTruncatedMeta(theme.fg("text", title), meta, theme),
			details:
				options.expanded && rawMultiline
					? new ToolBlockRecords([wrappedRecord(rawMultiline, (line) => theme.fg("muted", line))])
					: undefined,
			outputPad: options.outputPad,
		}),
	);
};

export const renderGoogleAccountMessage: MessageRenderer = (message, options, theme) => {
	const details =
		message.details && typeof message.details === "object"
			? (message.details as {
					readonly available?: unknown;
					readonly cookieAccessAllowed?: unknown;
					readonly email?: unknown;
				})
			: undefined;
	const rawMultiline = cleanMultiline(messageText(message.content));
	const rawOneLine = cleanOneLine(rawMultiline);
	const available = details?.available === true;
	const email = typeof details?.email === "string" ? cleanOneLine(details.email) : "";
	const cookieDisabled = details?.available === false && details?.cookieAccessAllowed === false;

	const status = available && email ? "success" : "info";
	let summary: string | undefined;
	if (available && email) summary = email;
	else if (available) summary = "Gemini Web available · account unknown";
	else if (cookieDisabled) summary = "browser cookie access disabled";
	else if (details?.available === false) summary = "Gemini Web unavailable";
	else if (rawOneLine) summary = rawOneLine;

	return new ReplayableBlock(
		new ToolBlock({
			status,
			title: titleWithTruncatedMeta(theme.fg("text", "Google account"), summary, theme),
			details:
				options.expanded && rawMultiline
					? new ToolBlockRecords([wrappedRecord(rawMultiline, (line) => theme.fg("muted", line))])
					: undefined,
			outputPad: options.outputPad,
		}),
	);
};

export const renderWebSearchResultsMessage: MessageRenderer = (message, options, theme) => {
	const details =
		message.details && typeof message.details === "object"
			? (message.details as {
					readonly outcome?: unknown;
					readonly curated?: unknown;
					readonly queryCount?: unknown;
					readonly totalResults?: unknown;
				})
			: undefined;
	const rawText = messageText(message.content).trim();
	const allFailed = details?.outcome === "all_failed";
	const curated = details?.curated === true;
	const meta: string[] = [];
	if (typeof details?.totalResults === "number" && Number.isFinite(details.totalResults)) {
		meta.push(`${details.totalResults} ${details.totalResults === 1 ? "result" : "results"}`);
	}
	if (typeof details?.queryCount === "number" && Number.isFinite(details.queryCount) && details.queryCount > 1) {
		meta.push(`${details.queryCount} queries`);
	}

	const markdown = new ToolBlockMarkdown(rawText);
	const body: Component | undefined = rawText
		? {
				invalidate: () => markdown.invalidate(),
				render: (bodyWidth: number) => {
					const rendered = markdown.render(bodyWidth);
					if (options.expanded || rendered.length <= TOOL_BLOCK_LIMITS.web) return rendered;
					return collapseToolBlockLines(rendered, TOOL_BLOCK_LIMITS.web, false);
				},
			}
		: undefined;

	return new ReplayableBlock(
		new ToolBlock({
			status: allFailed ? "failure" : "success",
			title: new Text(theme.fg("text", curated ? "Web search (curated)" : "Web search"), 0, 0),
			meta,
			body,
			outputPad: options.outputPad,
		}),
	);
};

export const renderWebSearchContentReadyMessage: MessageRenderer = (message, options, theme) => {
	const rawMultiline = cleanMultiline(messageText(message.content));
	const rawOneLine = cleanOneLine(rawMultiline);
	const match = CONTENT_READY_RE.exec(rawOneLine);
	const summary = match ? `${match[1]}/${match[2]} URLs fetched` : rawOneLine || undefined;
	const fetchId = match?.[3] ? cleanOneLine(match[3]) : "";

	const records: Component[] = [];
	if (options.expanded) {
		if (fetchId) records.push(wrappedRecord(`Fetch ID · ${fetchId}`, (line) => theme.fg("dim", line)));
		if (rawMultiline) {
			records.push(wrappedRecord(rawMultiline, (line) => theme.fg("muted", line)));
		} else {
			records.push(
				wrappedRecord("Full page content available via get_search_content.", (line) => theme.fg("muted", line)),
			);
		}
	}

	return new ReplayableBlock(
		new ToolBlock({
			status: "success",
			title: titleWithTruncatedMeta(theme.fg("text", "Web content ready"), summary, theme),
			details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
			outputPad: options.outputPad,
		}),
	);
};

export const renderWebSearchErrorMessage: MessageRenderer = (message, options, theme) => {
	const rawMultiline = cleanMultiline(messageText(message.content));
	const match = CONTENT_ERROR_RE.exec(rawMultiline);
	const fetchId = match?.[1] ? cleanOneLine(match[1]) : "";
	const reasonMultiline = match?.[2] ? match[2].trim() : rawMultiline;
	const firstLineReason = cleanOneLine(reasonMultiline.split("\n", 1)[0] ?? "");

	const records: Component[] = [];
	if (options.expanded) {
		if (fetchId) records.push(wrappedRecord(`Fetch ID · ${fetchId}`, (line) => theme.fg("dim", line)));
		if (reasonMultiline) records.push(wrappedRecord(reasonMultiline, (line) => theme.fg("error", line)));
	}

	return new ReplayableBlock(
		new ToolBlock({
			status: "failure",
			title: titleWithTruncatedMeta(theme.fg("text", "Web content fetch failed"), firstLineReason || undefined, theme),
			details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
			outputPad: options.outputPad,
		}),
	);
};

export const WEB_ACCESS_MESSAGE_RENDERERS: Readonly<Record<string, MessageRenderer>> = {
	"curator-config": renderCuratorConfigMessage,
	"google-account": renderGoogleAccountMessage,
	"web-search-results": renderWebSearchResultsMessage,
	"web-search-content-ready": renderWebSearchContentReadyMessage,
	"web-search-error": renderWebSearchErrorMessage,
};

export function registerWebAccessMessageRenderers(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
	for (const [customType, renderer] of Object.entries(WEB_ACCESS_MESSAGE_RENDERERS)) {
		pi.registerMessageRenderer?.(customType, renderer);
	}
}
