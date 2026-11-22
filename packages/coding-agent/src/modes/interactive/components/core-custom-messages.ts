import type { TextContent } from "@bastani/atomic-ai/compat";
import { type Component, Text, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
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

const OVERSIZED_ENTRY_RE = /^Saved entry (\d+) is (\d+) bytes\b/i;
const EVENT_REPORT_PREFIX_RE = /^Report from event child "([^"]+)" \(event ([^)]+)\):\s*\n\n/;

function cleanOneLine(value: string): string {
	return terminalDisplayText(value)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/ {2,}/g, " ")
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

function singleLineRecord(text: string): Component {
	return {
		invalidate(): void {},
		render(width: number): string[] {
			return width < 1 ? [] : [truncateToWidth(text, width, "…")];
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
				.map(cleanOneLine)
				.filter(Boolean)
		: [];
	const fallbackLines =
		rawNotices.length > 0
			? rawNotices
			: extractText(message.content)
					.split("\n")
					.map((line) => cleanOneLine(line.replace(/^\s*-\s*/, "")))
					.filter((line) => line.length > 0 && !/^Session recovery after restart:?$/i.test(line));
	const reason = typeof details?.reason === "string" ? cleanOneLine(details.reason) : "";
	const meta: string[] = [];
	if (fallbackLines.length === 1) {
		meta.push(fallbackLines[0]!);
	} else if (fallbackLines.length > 1) {
		meta.push(`${fallbackLines.length} notices`);
	} else if (reason) {
		meta.push(reason);
	}

	const records: Component[] = [];
	if (options.expanded) {
		for (const item of fallbackLines) {
			records.push(singleLineRecord(theme.fg("muted", item)));
		}
		if (reason) {
			records.push(singleLineRecord(theme.fg("dim", `Reason · ${reason}`)));
		}
	}

	return new ReplayableToolBlock(
		new ToolBlock({
			status: "info",
			title: new Text(theme.fg("text", "Session recovery"), 0, 0),
			meta,
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
	const titleText =
		entryIds.length > 0
			? `Replaying ${entryIds.length === 1 ? "1 interrupted delivery" : `${entryIds.length} interrupted deliveries`}`
			: cleanOneLine(extractText(message.content)).replace(/\s+from before the restart\.?$/i, "") ||
				"Replaying interrupted deliveries";

	const records: Component[] = [];
	if (options.expanded) {
		if (entryIds.length > 0) {
			records.push(singleLineRecord(theme.fg("muted", `Entries · ${entryIds.join(", ")}`)));
		}
		if (reason) {
			records.push(singleLineRecord(theme.fg("dim", `Reason · ${reason}`)));
		}
		if (records.length === 0) {
			const fallback = cleanOneLine(extractText(message.content));
			if (fallback) records.push(singleLineRecord(theme.fg("muted", fallback)));
		}
	}

	return new ReplayableToolBlock(
		new ToolBlock({
			status: "info",
			title: new Text(theme.fg("text", titleText), 0, 0),
			meta: ["from before restart"],
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
		if (subscriptionId) records.push(singleLineRecord(theme.fg("dim", `Subscription · ${subscriptionId}`)));
		if (eventId && eventId !== shortEventId) records.push(singleLineRecord(theme.fg("dim", `Event · ${eventId}`)));
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
	const raw = cleanOneLine(extractText(message.content));
	const match = OVERSIZED_ENTRY_RE.exec(raw);
	const meta: string[] = [];
	if (match) {
		const seq = match[1]!;
		const bytes = Number(match[2]);
		meta.push(`#${seq}`);
		if (Number.isFinite(bytes)) meta.push(formatByteSize(bytes));
	}

	const records: Component[] = [];
	if (options.expanded && raw) {
		records.push(singleLineRecord(theme.fg("muted", raw)));
	}

	return new ReplayableToolBlock(
		new ToolBlock({
			status: "info",
			title: new Text(
				theme.fg("text", match ? "Omitted large history entry" : raw || "Omitted large history entry"),
				0,
				0,
			),
			meta,
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
