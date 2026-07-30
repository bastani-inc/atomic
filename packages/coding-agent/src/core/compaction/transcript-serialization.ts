import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai/compat";
import type { NumberedRegion } from "./compaction-types.js";

export const FILTERED_MARKER_RE = /^\(filtered (\d+) lines\)$/;
export const LINE_NUMBER_SEPARATOR = "→";
export const ROLE_HEADER_RE = /^\[(User|Assistant|Assistant thinking|Assistant tool calls|Tool result)\]: /;

const TOOL_RESULT_MAX_CHARS = 16_000;

/** One piece of a serialized transcript: literal text, or an image kept at its position. */
export type TranscriptChunk = TextContent | ImageContent;

/**
 * `compacted` renders the durable transcript grammar: images become `[image]` markers and
 * oversized tool results are truncated. `retained` keeps every payload, for spans the
 * compaction promised to preserve verbatim.
 */
type SerializeMode = "compacted" | "retained";

export function filteredMarker(lineCount: number): string {
	return `(filtered ${lineCount} lines)`;
}

function truncateToolResult(text: string): string {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
	return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${text.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`;
}

function lastChunk(chunks: TranscriptChunk[]): TranscriptChunk | undefined {
	return chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
}

function appendText(chunks: TranscriptChunk[], text: string): void {
	if (text.length === 0) return;
	const last = lastChunk(chunks);
	if (last !== undefined && last.type === "text") last.text += text;
	else chunks.push({ type: "text", text });
}

function hasContent(chunks: TranscriptChunk[]): boolean {
	return chunks.some((chunk) => chunk.type !== "text" || chunk.text.length > 0);
}

function serializeContentBlocks(
	content: Extract<Message, { role: "user" | "toolResult" }>["content"],
	mode: SerializeMode,
): TranscriptChunk[] {
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	const chunks: TranscriptChunk[] = [];
	for (const block of content) {
		if (block.type === "text") {
			appendText(chunks, block.text);
			continue;
		}
		if (block.type !== "image") continue;
		if (mode === "retained") {
			if (chunks.length > 0) appendText(chunks, "\n");
			chunks.push({ ...block });
			continue;
		}
		const last = lastChunk(chunks);
		const needsBreak = last !== undefined && last.type === "text" && !last.text.endsWith("\n");
		appendText(chunks, `${needsBreak ? "\n" : ""}[image]\n`);
	}
	const trailing = lastChunk(chunks);
	if (trailing !== undefined && trailing.type === "text" && trailing.text.endsWith("\n")) {
		trailing.text = trailing.text.slice(0, -1);
	}
	return chunks;
}

/** Serialize provider messages into transcript chunks using the durable section grammar. */
function serializeTranscriptChunks(messages: Message[], mode: SerializeMode): TranscriptChunk[] {
	const chunks: TranscriptChunk[] = [];
	const pushSection = (header: string, section: TranscriptChunk[]): void => {
		if (!hasContent(section)) return;
		appendText(chunks, `${chunks.length > 0 ? "\n\n" : ""}${header}`);
		for (const chunk of section) {
			if (chunk.type === "text") appendText(chunks, chunk.text);
			else chunks.push(chunk);
		}
	};

	for (const message of messages) {
		if (message.role === "user") {
			pushSection("[User]: ", serializeContentBlocks(message.content, mode));
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
			if (thinking.length > 0) pushSection("[Assistant thinking]: ", [{ type: "text", text: thinking.join("\n") }]);
			if (text.length > 0) pushSection("[Assistant]: ", [{ type: "text", text: text.join("\n") }]);
			if (toolCalls.length > 0)
				pushSection("[Assistant tool calls]: ", [{ type: "text", text: toolCalls.join("; ") }]);
			continue;
		}

		if (message.role === "toolResult") {
			const section = serializeContentBlocks(message.content, mode);
			if (mode === "compacted") {
				for (const chunk of section) {
					if (chunk.type === "text") chunk.text = truncateToolResult(chunk.text);
				}
			}
			pushSection("[Tool result]: ", section);
		}
	}

	return chunks;
}

/** Serialize provider messages using the durable verbatim-compaction section grammar. */
export function serializeConversationForCompaction(messages: Message[]): string {
	return serializeTranscriptChunks(messages, "compacted")
		.map((chunk) => (chunk.type === "text" ? chunk.text : ""))
		.join("");
}

/**
 * Serialize retained messages without losing payloads: tool results keep their full text and
 * images stay as image blocks at their position in the transcript.
 */
export function serializeRetainedTranscript(messages: Message[]): TranscriptChunk[] {
	return serializeTranscriptChunks(messages, "retained");
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
