import {
	collapseToolBlockLines,
	type ExtensionAPI,
	type MessageRenderer,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockMarkdown,
	ToolBlockRecords,
	terminalDisplayText,
} from "@bastani/atomic";
import { type Component, Text, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";

const CONTENT_READY_RE = /^Content fetched for (\d+)\/(\d+) URLs \[([^\]]+)\]/;
const CONTENT_ERROR_RE = /^Content fetch failed \[([^\]]+)\]:\s*(.+)$/;

function cleanOneLine(value: string): string {
	return terminalDisplayText(value)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/ {2,}/g, " ")
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

function singleLineRecord(text: string): Component {
	return {
		invalidate(): void {},
		render(width: number): string[] {
			return width < 1 ? [] : [truncateToWidth(text, width, "…")];
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
	const workflow = details?.workflow;
	const title =
		workflow === "none"
			? "Search curator disabled"
			: workflow === "summary-review"
				? "Search curator enabled"
				: cleanOneLine(messageText(message.content)) || "Search curator updated";
	const meta =
		workflow === "none"
			? ["web_search returns raw results"]
			: workflow === "summary-review"
				? ["web_search opens curator with summary draft"]
				: [];
	return new ReplayableBlock(
		new ToolBlock({
			status: "info",
			title: new Text(theme.fg("text", title), 0, 0),
			meta,
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
	const rawText = cleanOneLine(messageText(message.content));
	const available = details?.available === true;
	const email = typeof details?.email === "string" ? cleanOneLine(details.email) : "";
	const cookieDisabled = details?.available === false && details?.cookieAccessAllowed === false;

	const status = available && email ? "success" : "info";
	const meta: string[] = [];
	if (available && email) meta.push(email);
	else if (available) meta.push("Gemini Web available · account unknown");
	else if (cookieDisabled) meta.push("browser cookie access disabled");
	else if (details?.available === false) meta.push("Gemini Web unavailable");
	else if (rawText) meta.push(rawText);

	const showDetail = options.expanded && rawText.length > 0 && !(available && email);
	return new ReplayableBlock(
		new ToolBlock({
			status,
			title: new Text(theme.fg("text", "Google account"), 0, 0),
			meta,
			details: showDetail ? new ToolBlockRecords([singleLineRecord(theme.fg("muted", rawText))]) : undefined,
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
	const rawText = cleanOneLine(messageText(message.content));
	const match = CONTENT_READY_RE.exec(rawText);
	const meta = match ? [`${match[1]}/${match[2]} URLs fetched`] : rawText ? [rawText] : [];
	const fetchId = match?.[3] ? cleanOneLine(match[3]) : "";

	const records: Component[] = [];
	if (options.expanded) {
		if (fetchId) records.push(singleLineRecord(theme.fg("dim", `Fetch ID · ${fetchId}`)));
		records.push(singleLineRecord(theme.fg("muted", "Full page content available via get_search_content.")));
	}

	return new ReplayableBlock(
		new ToolBlock({
			status: "success",
			title: new Text(theme.fg("text", "Web content ready"), 0, 0),
			meta,
			details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
			outputPad: options.outputPad,
		}),
	);
};

export const renderWebSearchErrorMessage: MessageRenderer = (message, options, theme) => {
	const rawText = cleanOneLine(messageText(message.content));
	const match = CONTENT_ERROR_RE.exec(rawText);
	const fetchId = match?.[1] ? cleanOneLine(match[1]) : "";
	const reason = match?.[2] ? cleanOneLine(match[2]) : rawText;
	const shortReason = visibleWidth(reason) > 48 ? truncateToWidth(reason, 48, "…") : reason;

	const records: Component[] = [];
	if (options.expanded) {
		if (fetchId) records.push(singleLineRecord(theme.fg("dim", `Fetch ID · ${fetchId}`)));
		if (reason) records.push(singleLineRecord(theme.fg("error", reason)));
	}

	return new ReplayableBlock(
		new ToolBlock({
			status: "failure",
			title: new Text(theme.fg("text", "Web content fetch failed"), 0, 0),
			meta: shortReason ? [shortReason] : [],
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
