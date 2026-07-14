import type { Message } from "@earendil-works/pi-ai/compat";
import type { NumberedRegion } from "./compaction-types.js";

export const FILTERED_MARKER_RE = /^\(filtered (\d+) lines\)$/;
export const LINE_NUMBER_SEPARATOR = "→";
export const ROLE_HEADER_RE = /^\[(User|Assistant|Assistant thinking|Assistant tool calls|Tool result)\]: /;

const TOOL_RESULT_MAX_CHARS = 16_000;

export function filteredMarker(lineCount: number): string {
	return `(filtered ${lineCount} lines)`;
}

function truncateToolResult(text: string): string {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
	return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`;
}

function serializeContentBlocks(content: Extract<Message, { role: "user" | "toolResult" }>["content"]): string {
	if (typeof content === "string") return content;
	let serialized = "";
	for (const block of content) {
		if (block.type === "text") serialized += block.text;
		else if (block.type === "image") serialized += `${serialized.endsWith("\n") || serialized.length === 0 ? "" : "\n"}[image]\n`;
	}
	return serialized.endsWith("\n") ? serialized.slice(0, -1) : serialized;
}

function serializeUserContent(message: Extract<Message, { role: "user" }>): string {
	return serializeContentBlocks(message.content);
}

function serializeToolResultContent(message: Extract<Message, { role: "toolResult" }>): string {
	return serializeContentBlocks(message.content);
}

/** Serialize provider messages using the durable verbatim-compaction section grammar. */
export function serializeConversationForCompaction(messages: Message[]): string {
	const sections: string[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const content = serializeUserContent(message);
			if (content) sections.push(`[User]: ${content}`);
			continue;
		}

		if (message.role === "assistant") {
			const text: string[] = [];
			const thinking: string[] = [];
			const toolCalls: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") text.push(block.text);
				else if (block.type === "thinking") thinking.push(block.thinking);
				else if (block.type === "toolCall") {
					const args = Object.entries(block.arguments)
						.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${args})`);
				}
			}
			if (thinking.length > 0) sections.push(`[Assistant thinking]: ${thinking.join("\n")}`);
			if (text.length > 0) sections.push(`[Assistant]: ${text.join("\n")}`);
			if (toolCalls.length > 0) sections.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			continue;
		}

		if (message.role === "toolResult") {
			const content = serializeToolResultContent(message);
			if (content) sections.push(`[Tool result]: ${truncateToolResult(content)}`);
		}
	}

	return sections.join("\n\n");
}

export function createNumberedRegion(text: string, protectedLineNumbers?: ReadonlySet<number>): NumberedRegion {
	const lines = text.split("\n");
	const headerLineNumbers = new Set<number>();
	const priorMarkerNs = new Map<number, number>();
	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1;
		if (ROLE_HEADER_RE.test(lines[index])) headerLineNumbers.add(lineNumber);
		const markerMatch = FILTERED_MARKER_RE.exec(lines[index]);
		if (markerMatch) priorMarkerNs.set(lineNumber, Number(markerMatch[1]));
	}
	return {
		__brand: "NumberedRegion",
		lines,
		headerLineNumbers,
		priorMarkerNs,
		protectedLineNumbers,
		tokenEstimate: Math.ceil(text.length / 4),
	};
}

export function numberRegionLines(region: NumberedRegion, start = 1, end = region.lines.length): string {
	const first = Math.max(1, Math.trunc(start));
	const last = Math.min(region.lines.length, Math.trunc(end));
	if (first > last) return "";
	return region.lines
		.slice(first - 1, last)
		.map((line, index) => `${first + index}${LINE_NUMBER_SEPARATOR}${line}`)
		.join("\n");
}
