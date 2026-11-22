import type { TextContent } from "@bastani/atomic-ai/compat";
import { type Component, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";
import { SESSION_RECOVERY_NOTICE_TYPE, SESSION_RECOVERY_REPLAY_TYPE } from "../../../core/agent-session-recovery.ts";
import { EVENT_REPORT_MESSAGE_TYPE } from "../../../core/event-subscriptions/session-subscription.js";
import type { MessageRenderOptions } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { terminalDisplayText } from "../../../utils/terminal-text.ts";
import type { Theme } from "../theme/theme.js";
import {
	collapseToolBlockLines,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockMarkdown,
	ToolBlockRecords,
} from "./tool-block.ts";

export const OVERSIZED_HISTORY_ENTRY_TYPE = "atomic.oversized-history-entry";

const OVERSIZED_ENTRY_RE = /^Saved (?:(file )?entry(?: at byte)? (\d+)) is (\d+) bytes\b/i;
const EVENT_REPORT_PREFIX_RE = /^Report from event child "([^"]+)" \(event ([^)]+)\):\s*\n\n/;

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

function extractText(content: CustomMessage<unknown>["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function formatByteSize(bytes: number): string {
	const safe = Math.max(0, Math.floor(bytes));
	if (safe < 1024) return `${safe} B`;
	if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
	if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
	return `${(safe / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Wraps multi-line text to the available width without truncating any content. */
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

/** Keeps the title intact and truncates a single trailing dim summary to the remaining width instead of dropping it. */
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

class ReplayableToolBlock implements Component {
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

function renderSessionRecoveryNotice(
	message: CustomMessage<unknown>,
	options: MessageRenderOptions,
	theme: Theme,
): Component {
	const details =
		message.details && typeof message.details === "object"
			? (message.details as { readonly reason?: unknown; readonly notices?: unknown })
			: undefined;
	const rawNotices = Array.isArray(details?.notices)
		? details.notices
				.filter((item): item is string => typeof item === "string")
				.map(cleanMultiline)
				.filter(Boolean)
		: [];
	const fallbackLines =
		rawNotices.length > 0
			? rawNotices
			: (() => {
					const raw = cleanMultiline(extractText(message.content));
					const body = raw.replace(/^Session recovery after restart:?\n?/i, "");
					if (!body) return [];
					return body
						.split("\n")
						.map((line) => line.replace(/^\s*-\s*/, ""))
						.filter((line) => line.trim().length > 0);
				})();
	const reason = typeof details?.reason === "string" ? cleanOneLine(details.reason) : "";
	const summary =
		fallbackLines.length === 1
			? cleanOneLine(fallbackLines[0]!)
			: fallbackLines.length > 1
				? `${fallbackLines.length} notices`
				: reason || undefined;

	const records: Component[] = [];
	if (options.expanded) {
		for (const item of fallbackLines) {
			records.push(wrappedRecord(item, (line) => theme.fg("muted", line)));
		}
		if (reason) {
			records.push(wrappedRecord(`Reason · ${reason}`, (line) => theme.fg("dim", line)));
		}
	}

	return new ReplayableToolBlock(
		new ToolBlock({
			status: "info",
			title: titleWithTruncatedMeta(theme.fg("text", "Session recovery"), summary, theme),
			details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
			outputPad: options.outputPad,
		}),
	);
}

function renderSessionRecoveryReplay(
	message: CustomMessage<unknown>,
	options: MessageRenderOptions,
	theme: Theme,
): Component {
	const details =
		message.details && typeof message.details === "object"
			? (message.details as { readonly reason?: unknown; readonly entryIds?: unknown })
			: undefined;
	const entryIds = Array.isArray(details?.entryIds)
		? details.entryIds
				.filter((id): id is string => typeof id === "string")
				.map(cleanOneLine)
				.filter(Boolean)
		: [];
	const reason = typeof details?.reason === "string" ? cleanOneLine(details.reason) : "";
	const rawText = cleanMultiline(extractText(message.content));
	const titleText =
		entryIds.length > 0
			? `Replaying ${entryIds.length === 1 ? "1 interrupted delivery" : `${entryIds.length} interrupted deliveries`}`
			: cleanOneLine(rawText).replace(/\s+from before the restart\.?$/i, "") || "Replaying interrupted deliveries";

	const records: Component[] = [];
	if (options.expanded) {
		if (rawText) {
			records.push(wrappedRecord(rawText, (line) => theme.fg("muted", line)));
		}
		if (entryIds.length > 0) {
			records.push(wrappedRecord(`Entries · ${entryIds.join(", ")}`, (line) => theme.fg("muted", line)));
		}
		if (reason) {
			records.push(wrappedRecord(`Reason · ${reason}`, (line) => theme.fg("dim", line)));
		}
	}

	return new ReplayableToolBlock(
		new ToolBlock({
			status: "info",
			title: titleWithTruncatedMeta(theme.fg("text", titleText), "from before restart", theme),
			details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
			outputPad: options.outputPad,
		}),
	);
}

function renderEventReport(message: CustomMessage<unknown>, options: MessageRenderOptions, theme: Theme): Component {
	const rawContent = extractText(message.content);
	const details =
		message.details && typeof message.details === "object"
			? (message.details as {
					readonly subscriptionId?: unknown;
					readonly eventId?: unknown;
					readonly child?: unknown;
				})
			: undefined;
	const prefixMatch = EVENT_REPORT_PREFIX_RE.exec(rawContent);
	const child = cleanOneLine(typeof details?.child === "string" ? details.child : (prefixMatch?.[1] ?? "event child"));
	const eventId = cleanOneLine(typeof details?.eventId === "string" ? details.eventId : (prefixMatch?.[2] ?? ""));
	const subscriptionId = typeof details?.subscriptionId === "string" ? cleanOneLine(details.subscriptionId) : "";
	const bodyText = prefixMatch ? rawContent.slice(prefixMatch[0].length) : rawContent;
	const markdown = new ToolBlockMarkdown(bodyText.trim());
	const shortEventId = visibleWidth(eventId) > 20 ? truncateToWidth(eventId, 20, "…") : eventId;

	const title = `${theme.fg("muted", "Event report from")} ${theme.fg("accent", theme.bold(child))}`;
	const meta = shortEventId ? [`event ${shortEventId}`] : [];

	const bodyComponent: Component | undefined = bodyText.trim()
		? {
				invalidate: () => markdown.invalidate(),
				render: (bodyWidth: number) => {
					const rendered = markdown.render(bodyWidth);
					if (options.expanded || rendered.length <= TOOL_BLOCK_LIMITS.inbound) return rendered;
					return collapseToolBlockLines(rendered, TOOL_BLOCK_LIMITS.inbound, false);
				},
			}
		: undefined;

	const records: Component[] = [];
	if (options.expanded) {
		if (child) records.push(wrappedRecord(`Child · ${child}`, (line) => theme.fg("dim", line)));
		if (eventId) records.push(wrappedRecord(`Event · ${eventId}`, (line) => theme.fg("dim", line)));
		if (subscriptionId) {
			records.push(wrappedRecord(`Subscription · ${subscriptionId}`, (line) => theme.fg("dim", line)));
		}
	}

	return new ReplayableToolBlock(
		new ToolBlock({
			status: "info",
			title: new Text(title, 0, 0),
			meta,
			body: bodyComponent,
			details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
			outputPad: options.outputPad,
		}),
	);
}

function renderOversizedHistoryEntry(
	message: CustomMessage<unknown>,
	options: MessageRenderOptions,
	theme: Theme,
): Component {
	const rawMultiline = cleanMultiline(extractText(message.content));
	const rawOneLine = cleanOneLine(rawMultiline);
	const match = OVERSIZED_ENTRY_RE.exec(rawOneLine);
	const metaParts: string[] = [];
	if (match) {
		const isFile = Boolean(match[1]);
		const seqOrOffset = match[2]!;
		const bytes = Number(match[3]);
		metaParts.push(isFile ? `byte ${seqOrOffset}` : `#${seqOrOffset}`);
		if (Number.isFinite(bytes)) metaParts.push(formatByteSize(bytes));
	}

	const records: Component[] = [];
	if (options.expanded && rawMultiline) {
		records.push(wrappedRecord(rawMultiline, (line) => theme.fg("muted", line)));
	}

	const headerTitle = match ? "Omitted large history entry" : rawOneLine || "Omitted large history entry";
	const headerMeta = metaParts.length > 0 ? metaParts.join(" · ") : undefined;

	return new ReplayableToolBlock(
		new ToolBlock({
			status: "info",
			title: titleWithTruncatedMeta(theme.fg("text", headerTitle), headerMeta, theme),
			details: records.length > 0 ? new ToolBlockRecords(records) : undefined,
			outputPad: options.outputPad,
		}),
	);
}

/**
 * Renders Atomic's built-in core `display: true` custom messages in the shared `ToolBlock`/`NoticeLine` grammar so
 * they never fall back to the generic bracketed `[customType]` box.
 */
export function renderCoreCustomMessage(
	message: CustomMessage<unknown>,
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	switch (message.customType) {
		case SESSION_RECOVERY_NOTICE_TYPE:
			return renderSessionRecoveryNotice(message, options, theme);
		case SESSION_RECOVERY_REPLAY_TYPE:
			return renderSessionRecoveryReplay(message, options, theme);
		case EVENT_REPORT_MESSAGE_TYPE:
			return renderEventReport(message, options, theme);
		case OVERSIZED_HISTORY_ENTRY_TYPE:
			return renderOversizedHistoryEntry(message, options, theme);
		default:
			return undefined;
	}
}
