import type { SessionEntry } from "../session-manager-types.ts";
import type { SessionRecordHeader } from "../storage/session/types.js";

const LINE_WIDTH = 4000;

/** Splits one line into parts of at most `LINE_WIDTH` characters, preferring a space, so no character is lost. */
export function wrapLine(line: string): string[] {
	const parts: string[] = [];
	let rest = line;
	while (rest.length > LINE_WIDTH) {
		let cut = rest.lastIndexOf(" ", LINE_WIDTH - 1) + 1;
		if (cut < LINE_WIDTH * 0.75) {
			cut = LINE_WIDTH;
			const last = rest.charCodeAt(cut - 1);
			if (last >= 0xd800 && last <= 0xdbff) cut--;
		}
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	parts.push(rest);
	return parts;
}

export function textLines(text: string): string[] {
	return text.split("\n").flatMap(wrapLine);
}

export function timestamp(value: string | number | undefined): string {
	if (value === undefined) return "unknown time";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

interface ContentBlock {
	readonly type?: string;
	readonly text?: string;
	readonly name?: string;
	readonly arguments?: unknown;
}

function contentLines(content: unknown): string[] {
	if (typeof content === "string") return textLines(content);
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const block of content as ContentBlock[]) {
		if (block.type === "text" && typeof block.text === "string") lines.push(...textLines(block.text));
		else if (block.type === "toolCall")
			lines.push(...wrapLine(`[tool call] ${block.name ?? "unknown"} ${JSON.stringify(block.arguments ?? {})}`));
		else if (block.type === "image") lines.push("[image]");
	}
	return lines;
}

export function entryLines(entry: SessionEntry): string[] {
	const heading = (label: string): string[] => textLines(`## ${timestamp(entry.timestamp)} ${label}`);
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			switch (message.role) {
				case "user":
					return [...heading("user"), ...contentLines(message.content)];
				case "assistant":
					return [...heading("assistant"), ...contentLines(message.content)];
				case "toolResult":
					return [...heading(`tool result ${message.toolName}`), ...contentLines(message.content)];
				case "bashExecution":
					return [...heading("bash"), ...textLines(`$ ${message.command}`), ...textLines(message.output)];
				case "custom":
					return [...heading(`custom ${message.customType}`), ...contentLines(message.content)];
				case "branchSummary":
					return [...heading("branch summary"), ...textLines(message.summary)];
				default:
					return [];
			}
		}
		case "custom_message":
			return [...heading(`custom ${entry.customType}`), ...contentLines(entry.content)];
		case "compaction":
		case "branch_summary":
		case "session_summary":
			return [...heading(entry.type.replace("_", " ")), ...textLines(entry.summary)];
		case "session_info":
			return entry.name ? heading(`session name: ${entry.name}`) : [];
		default:
			return [];
	}
}

export interface HistoryEntryRange {
	readonly start: number;
	readonly end: number;
}

export function transcriptHeaderLines(header: SessionRecordHeader): string[] {
	return [`# session ${header.id}`, `created: ${timestamp(header.createdAt)}`];
}

export interface HistoryEntrySeqs {
	getEntries(): readonly SessionEntry[];
	getEntrySeq(id: string): number | undefined;
}

export function historyEntryRanges(session: HistoryEntrySeqs): ReadonlyMap<string, HistoryEntryRange> {
	const ranges = new Map<string, HistoryEntryRange>();
	for (const entry of session.getEntries()) {
		const seq = session.getEntrySeq(entry.id);
		if (seq !== undefined) ranges.set(entry.id, { start: seq, end: seq });
	}
	return ranges;
}
