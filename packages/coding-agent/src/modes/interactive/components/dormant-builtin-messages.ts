import type { TextContent } from "@bastani/atomic-ai/compat";
import {
	type Component,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import { terminalDisplayText } from "../../../utils/terminal-text.ts";
import type { Theme } from "../theme/theme.js";
import {
	collapseToolBlockLines,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockMarkdown,
	ToolBlockRecords,
} from "./tool-block.ts";

const WAKE_GLYPH = "↻";
const DETAIL_FIRST_PREFIX = "  ⎿  ";
const DETAIL_PREFIX = "     ";
const SUBAGENT_TARGET_RE = /^subagent-(.+)-([0-9a-f]{6,})-(\d+)$/i;
const UNNAMED_CHAT_ALIAS_RE = /^subagent-chat-([0-9a-f]{8})(?:-[0-9a-f-]+)?$/i;
const UUID_RE = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_WAKE_RE = /^Resuming subagent `([^`]+)`(?:\s+\(([^)]+)\))?\s+for an Intercom message from ([^.]+)\./;
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
		.filter((part): part is TextContent => {
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

function formatWakeParticipant(rawName: string | undefined, rawId: string | undefined): string {
	const name = rawName ? cleanOneLine(rawName) : "";
	const id = rawId ? cleanOneLine(rawId) : "";
	const candidate = name || id;
	if (!candidate) return "unknown";
	const aliasMatch = UNNAMED_CHAT_ALIAS_RE.exec(candidate);
	if (aliasMatch) return `session ${aliasMatch[1]!.toLowerCase()}`;
	const subagentMatch = SUBAGENT_TARGET_RE.exec(candidate);
	if (subagentMatch) return `subagent-${subagentMatch[1]}-…-${subagentMatch[3]}`;
	const uuidMatch = UUID_RE.exec(candidate);
	if (uuidMatch) return uuidMatch[1]!.toLowerCase();
	return visibleWidth(candidate) > 36 ? truncateToWidth(candidate, 36, "…") : candidate;
}

interface ParsedWake {
	readonly childName: string;
	readonly childId?: string;
	readonly fromName?: string;
	readonly fromId?: string;
	readonly depth?: number;
}

function parseWake(content: unknown, details: unknown): ParsedWake | undefined {
	const record =
		details && typeof details === "object"
			? (details as {
					readonly childName?: unknown;
					readonly childId?: unknown;
					readonly from?: { readonly id?: unknown; readonly name?: unknown } | null;
					readonly depth?: unknown;
				})
			: undefined;
	const rawChildName = typeof record?.childName === "string" ? cleanOneLine(record.childName) : "";
	if (rawChildName) {
		const rawChildId = typeof record?.childId === "string" ? cleanOneLine(record.childId) : "";
		const fromRecord = record?.from && typeof record.from === "object" ? record.from : undefined;
		const rawFromName = typeof fromRecord?.name === "string" ? cleanOneLine(fromRecord.name) : "";
		const rawFromId = typeof fromRecord?.id === "string" ? cleanOneLine(fromRecord.id) : "";
		const rawDepth =
			typeof record?.depth === "number" && Number.isFinite(record.depth) ? Math.floor(record.depth) : undefined;
		return {
			childName: rawChildName,
			...(rawChildId ? { childId: rawChildId } : {}),
			...(rawFromName ? { fromName: rawFromName } : {}),
			...(rawFromId ? { fromId: rawFromId } : {}),
			...(rawDepth !== undefined && rawDepth >= 1 ? { depth: rawDepth } : {}),
		};
	}

	const text = cleanOneLine(messageText(content));
	const legacy = LEGACY_WAKE_RE.exec(text);
	if (!legacy) return undefined;
	const childName = cleanOneLine(legacy[1] ?? "");
	if (!childName) return undefined;
	const childId = legacy[2] ? cleanOneLine(legacy[2]) : undefined;
	const sender = legacy[3] ? cleanOneLine(legacy[3]) : undefined;
	return {
		childName,
		...(childId ? { childId } : {}),
		...(sender ? { fromName: sender } : {}),
	};
}

class DormantWakeNoticeComponent implements Component {
	readonly historyReplayable = true;
	private readonly parsed: ParsedWake | undefined;
	private readonly fallbackText: string;
	private readonly fallbackMultiline: string;
	private readonly expanded: boolean;
	private readonly outputPad: number;
	private readonly theme: Theme;

	constructor(
		parsed: ParsedWake | undefined,
		fallbackText: string,
		fallbackMultiline: string,
		expanded: boolean,
		outputPad: number,
		theme: Theme,
	) {
		this.parsed = parsed;
		this.fallbackText = fallbackText;
		this.fallbackMultiline = fallbackMultiline;
		this.expanded = expanded;
		this.outputPad = outputPad;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 1) return [];
		const safeWidth = Math.floor(width);
		const pad = Math.max(0, Math.min(Math.floor(this.outputPad), safeWidth - 1));
		const contentWidth = Math.max(1, safeWidth - pad);
		const noColor = process.env.NO_COLOR !== undefined;
		const finish = (row: string): string => {
			const padded = `${" ".repeat(pad)}${row}`;
			return noColor ? stripTerminalSequences(padded) : padded;
		};

		const glyph = this.theme.fg("accent", WAKE_GLYPH);
		if (contentWidth < 2) return [finish(truncateToWidth(glyph, contentWidth, ""))];

		const parsed = this.parsed;
		let header: string;
		if (parsed) {
			const shortChild = formatWakeParticipant(parsed.childName, undefined);
			const shortSender = formatWakeParticipant(parsed.fromName, parsed.fromId);
			const title = `${this.theme.fg("muted", "Woke")} ${this.theme.fg("toolTitle", this.theme.bold(shortChild))} ${this.theme.fg("muted", "for a message from")} ${this.theme.fg("text", shortSender)}`;
			const metaPlain = " · result arrives here";
			const titleWidth = visibleWidth(title);
			const metaWidth = visibleWidth(metaPlain);
			if (2 + titleWidth + metaWidth <= contentWidth) {
				header = `${glyph} ${title}${this.theme.fg("dim", metaPlain)}`;
			} else if (2 + titleWidth <= contentWidth) {
				header = `${glyph} ${title}`;
			} else {
				header = `${glyph} ${truncateToWidth(title, contentWidth - 2, "…")}`;
			}
		} else {
			const label = this.fallbackText || "Woke subagent for an Intercom message";
			header = `${glyph} ${truncateToWidth(this.theme.fg("text", label), contentWidth - 2, "…")}`;
		}

		if (!this.expanded) return [finish(header)];

		const details: string[] = [];
		if (parsed) {
			const childLine = parsed.childId ? `${parsed.childName} · ${parsed.childId}` : parsed.childName;
			details.push(`${this.theme.fg("dim", "Subagent  ")}${this.theme.fg("muted", childLine)}`);
			const fromDisplay = parsed.fromName ?? parsed.fromId ?? "unknown";
			details.push(`${this.theme.fg("dim", "From      ")}${this.theme.fg("muted", fromDisplay)}`);
			if (parsed.fromName && parsed.fromId && parsed.fromId !== parsed.fromName) {
				details.push(`${this.theme.fg("dim", "Sender ID ")}${this.theme.fg("dim", parsed.fromId)}`);
			}
			if (parsed.depth !== undefined && parsed.depth > 1) {
				details.push(`${this.theme.fg("dim", "Depth     ")}${this.theme.fg("muted", String(parsed.depth))}`);
			}
			details.push(this.theme.fg("dim", "Result stays with this session and arrives here."));
		} else if (this.fallbackMultiline) {
			for (const line of this.fallbackMultiline.split("\n")) {
				details.push(this.theme.fg("muted", line));
			}
		}

		const detailWidth = contentWidth > DETAIL_PREFIX.length ? contentWidth - DETAIL_PREFIX.length : contentWidth;
		const rows = [header];
		let firstRow = true;
		for (const line of details) {
			const wrappedLines = wrapTextWithAnsi(line, Math.max(1, detailWidth));
			for (const wrapped of wrappedLines) {
				if (contentWidth > DETAIL_PREFIX.length) {
					const prefix = firstRow ? this.theme.fg("dim", DETAIL_FIRST_PREFIX) : DETAIL_PREFIX;
					rows.push(`${prefix}${wrapped}`);
				} else {
					rows.push(truncateToWidth(wrapped, contentWidth, "…"));
				}
				firstRow = false;
			}
		}
		return rows.map(finish);
	}
}

/** Dormant renderer for `intercom_subagent_wake`, matching `packages/intercom/ui/wake-notice.ts` before activation. */
export const renderDormantIntercomWakeMessage: MessageRenderer = (message, options, theme) => {
	const raw = messageText(message.content);
	const parsed = parseWake(message.content, message.details);
	const fallbackText = cleanOneLine(raw);
	const fallbackMultiline = cleanMultiline(raw);
	return new DormantWakeNoticeComponent(
		parsed,
		fallbackText,
		fallbackMultiline,
		options.expanded,
		options.outputPad ?? 1,
		theme,
	);
};

/** Dormant renderer for `curator-config`, matching `packages/web-access/message-renderers.ts` before activation. */
export const renderDormantCuratorConfigMessage: MessageRenderer = (message, options, theme) => {
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

/** Dormant renderer for `google-account`, matching `packages/web-access/message-renderers.ts` before activation. */
export const renderDormantGoogleAccountMessage: MessageRenderer = (message, options, theme) => {
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

/** Dormant renderer for `web-search-results`, matching `packages/web-access/message-renderers.ts` before activation. */
export const renderDormantWebSearchResultsMessage: MessageRenderer = (message, options, theme) => {
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

/** Dormant renderer for `web-search-content-ready`, matching `packages/web-access/message-renderers.ts` before activation. */
export const renderDormantWebSearchContentReadyMessage: MessageRenderer = (message, options, theme) => {
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

/** Dormant renderer for `web-search-error`, matching `packages/web-access/message-renderers.ts` before activation. */
export const renderDormantWebSearchErrorMessage: MessageRenderer = (message, options, theme) => {
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
			title: titleWithTruncatedMeta(
				theme.fg("text", "Web content fetch failed"),
				firstLineReason || undefined,
				theme,
			),
			details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
			outputPad: options.outputPad,
		}),
	);
};

export const DORMANT_WEB_ACCESS_MESSAGE_RENDERERS: Readonly<Record<string, MessageRenderer>> = {
	"curator-config": renderDormantCuratorConfigMessage,
	"google-account": renderDormantGoogleAccountMessage,
	"web-search-results": renderDormantWebSearchResultsMessage,
	"web-search-content-ready": renderDormantWebSearchContentReadyMessage,
	"web-search-error": renderDormantWebSearchErrorMessage,
};
