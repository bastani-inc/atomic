import { type MessageRenderer, type Theme, terminalDisplayText } from "@bastani/atomic";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";

/** #5999: the notice, in the session that launched a subagent, that it is resuming it for another session's message. */
export const ENDED_CHILD_WAKE_MESSAGE_TYPE = "intercom_subagent_wake";

const WAKE_GLYPH = "↻";
const DETAIL_FIRST_PREFIX = "  ⎿  ";
const DETAIL_PREFIX = "     ";
const SUBAGENT_TARGET_RE = /^subagent-(.+)-([0-9a-f]{6,})-(\d+)$/i;
const UNNAMED_CHAT_ALIAS_RE = /^subagent-chat-([0-9a-f]{8})(?:-[0-9a-f-]+)?$/i;
const UUID_RE = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_CONTENT_RE = /^Resuming subagent `([^`]+)`(?:\s+\(([^)]+)\))?\s+for an Intercom message from ([^.]+)\./;

export interface IntercomWakeDetails {
	readonly childName?: unknown;
	readonly childId?: unknown;
	readonly from?: { readonly id?: unknown; readonly name?: unknown } | null;
	readonly depth?: unknown;
}

interface ParsedWakeNotice {
	readonly childName: string;
	readonly childId?: string;
	readonly fromName?: string;
	readonly fromId?: string;
	readonly depth?: number;
}

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

/** Shorten raw subagent handles and UUID session IDs for compact display while preserving copyable identities on expand. */
export function formatWakeParticipant(rawName: string | undefined, rawId: string | undefined): string {
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

function parseWakeNotice(content: unknown, details: unknown): ParsedWakeNotice | undefined {
	const record = details && typeof details === "object" ? (details as IntercomWakeDetails) : undefined;
	const rawChildName = typeof record?.childName === "string" ? cleanOneLine(record.childName) : "";
	if (rawChildName) {
		const rawChildId = typeof record?.childId === "string" ? cleanOneLine(record.childId) : "";
		const fromRecord = record?.from && typeof record.from === "object" ? record.from : undefined;
		const rawFromName = typeof fromRecord?.name === "string" ? cleanOneLine(fromRecord.name) : "";
		const rawFromId = typeof fromRecord?.id === "string" ? cleanOneLine(fromRecord.id) : "";
		const rawDepth = typeof record?.depth === "number" && Number.isFinite(record.depth) ? Math.floor(record.depth) : undefined;
		return {
			childName: rawChildName,
			...(rawChildId ? { childId: rawChildId } : {}),
			...(rawFromName ? { fromName: rawFromName } : {}),
			...(rawFromId ? { fromId: rawFromId } : {}),
			...(rawDepth !== undefined && rawDepth >= 1 ? { depth: rawDepth } : {}),
		};
	}

	const text = cleanOneLine(messageText(content));
	const legacy = LEGACY_CONTENT_RE.exec(text);
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

class WakeNoticeComponent implements Component {
	readonly historyReplayable = true;
	private readonly parsed: ParsedWakeNotice | undefined;
	private readonly fallbackText: string;
	private readonly expanded: boolean;
	private readonly outputPad: number;
	private readonly theme: Theme;

	constructor(
		parsed: ParsedWakeNotice | undefined,
		fallbackText: string,
		expanded: boolean,
		outputPad: number,
		theme: Theme,
	) {
		this.parsed = parsed;
		this.fallbackText = fallbackText;
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
		if (contentWidth < 2) {
			return [finish(truncateToWidth(glyph, contentWidth, ""))];
		}

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

		if (!this.expanded) {
			return [finish(header)];
		}

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
		} else if (this.fallbackText) {
			details.push(this.theme.fg("muted", this.fallbackText));
		}

		const rows = [header];
		for (let i = 0; i < details.length; i += 1) {
			const line = details[i]!;
			if (contentWidth > DETAIL_PREFIX.length) {
				const prefix = i === 0 ? this.theme.fg("dim", DETAIL_FIRST_PREFIX) : DETAIL_PREFIX;
				rows.push(`${prefix}${truncateToWidth(line, contentWidth - DETAIL_PREFIX.length, "…")}`);
			} else {
				rows.push(truncateToWidth(line, contentWidth, "…"));
			}
		}
		return rows.map(finish);
	}
}

export const renderIntercomWakeMessage: MessageRenderer = (message, options, theme) => {
	const parsed = parseWakeNotice(message.content, message.details);
	const fallbackText = cleanOneLine(messageText(message.content));
	return new WakeNoticeComponent(parsed, fallbackText, options.expanded, options.outputPad ?? 1, theme);
};
