import type { ImageContent, Message, TextContent } from "@bastani/atomic-ai/compat";
import type { NumberedRegion } from "./compaction-types.js";

export const FILTERED_MARKER_RE = /^\(filtered (\d+) lines\)$/;
const ROLE_NAMES = "User|Assistant|Assistant tool calls|Tool result";
export const ROLE_HEADER_RE = new RegExp(`^\\[(${ROLE_NAMES})\\]: `);

/** A line break inside a message body followed by text that would read as a role header. */
const BODY_HEADER_LINE_RE = new RegExp(`\\n(?=\\[(?:${ROLE_NAMES})\\]: )`, "g");

/**
 * Escape body lines that would read as role headers by prefixing a backslash, so header lines in
 * serialized text are only ever the serializer's own. `atLineStart` says the text begins a line,
 * as text following an image block does.
 */
function escapeBodyHeaders(text: string, atLineStart: boolean): string {
	const escaped = text.replace(BODY_HEADER_LINE_RE, "\n\\");
	return atLineStart && ROLE_HEADER_RE.test(escaped) ? `\\${escaped}` : escaped;
}

/**
 * Header of the thinking section that transcripts serialized before prompt version 5 carried.
 * Current transcripts never emit it; it is recognized only to drop those sections from older summaries.
 */
const LEGACY_THINKING_HEADER = "[Assistant thinking]: ";

const TOOL_RESULT_MAX_CHARS = 2_000;

/** One piece of a serialized transcript: literal text, or an image kept at its position. */
export type TranscriptChunk = TextContent | ImageContent;

/**
 * `compacted` renders the durable transcript grammar: images become `[image]` markers and
 * oversized tool results are truncated. `retained` keeps every payload, for spans the
 * compaction promised to preserve verbatim. Both modes omit thinking, as `serializeConversation()`
 * does for summaries.
 */
type SerializeMode = "compacted" | "retained";

/** Where a tool result's full output can be read back: a `history://sessions/<id>:N-M` URL, keyed by the message. */
export type FullOutputLocators = ReadonlyMap<Message, string>;

function truncateToolResult(text: string, fullOutputUrl: string | undefined): string {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
	const removed = text.length - TOOL_RESULT_MAX_CHARS;
	const where =
		fullOutputUrl === undefined
			? "the full output is in this session's history"
			: `full output: read ${fullOutputUrl}`;
	return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${removed} more characters truncated; ${where}]`;
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

/**
 * Serialize provider messages into transcript chunks using the durable section grammar.
 *
 * The sections match `serializeConversation()`: user text, assistant text, assistant tool calls,
 * and tool results. Thinking is omitted. Providers return summaries of the real reasoning, and
 * some refuse a compaction request that replays earlier thinking as transcript text (#4544).
 */
function serializeTranscriptChunks(
	messages: Message[],
	mode: SerializeMode,
	locators?: FullOutputLocators,
): TranscriptChunk[] {
	const chunks: TranscriptChunk[] = [];
	const pushSection = (header: string, section: TranscriptChunk[]): void => {
		if (!hasContent(section)) return;
		appendText(chunks, `${chunks.length > 0 ? "\n\n" : ""}${header}`);
		section.forEach((chunk, index) => {
			if (chunk.type === "text")
				// Adjacent text blocks are already merged, so a text chunk past the first follows an image.
				appendText(chunks, escapeBodyHeaders(chunk.text, index > 0));
			else chunks.push(chunk);
		});
	};

	for (const message of messages) {
		if (message.role === "user") {
			pushSection("[User]: ", serializeContentBlocks(message.content, mode));
			continue;
		}

		if (message.role === "assistant") {
			const text: string[] = [];
			const toolCalls: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") text.push(block.text);
				else if (block.type === "toolCall") {
					const args = Object.entries(block.arguments)
						.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${args})`);
				}
			}
			if (text.length > 0) pushSection("[Assistant]: ", [{ type: "text", text: text.join("\n") }]);
			if (toolCalls.length > 0)
				pushSection("[Assistant tool calls]: ", [{ type: "text", text: toolCalls.join("; ") }]);
			continue;
		}

		if (message.role === "toolResult") {
			const section = serializeContentBlocks(message.content, mode);
			if (mode === "compacted") {
				for (const chunk of section) {
					if (chunk.type === "text") chunk.text = truncateToolResult(chunk.text, locators?.get(message));
				}
			}
			pushSection("[Tool result]: ", section);
		}
	}

	return chunks;
}

/**
 * Serialize provider messages using the durable verbatim-compaction section grammar.
 * A truncated tool result names its location in `locators` when it has one, and otherwise says only that the
 * full output is in the session's history.
 */
export function serializeConversationForCompaction(messages: Message[], locators?: FullOutputLocators): string {
	return serializeTranscriptChunks(messages, "compacted", locators)
		.map((chunk) => (chunk.type === "text" ? chunk.text : ""))
		.join("");
}

/**
 * Serialize retained messages without losing payloads: tool results keep their full text and
 * images stay as image blocks at their position in the transcript. Thinking is omitted.
 */
export function serializeRetainedTranscript(messages: Message[]): TranscriptChunk[] {
	return serializeTranscriptChunks(messages, "retained");
}

/**
 * Drop the `[Assistant thinking]: ` sections from a transcript serialized before prompt version 5.
 *
 * A section runs from its header to the next role header or `(filtered N lines)` marker. Stopping
 * at a marker is deliberate: a prior compaction may have deleted the following header along with
 * part of the section, so the lines after the marker can belong to the next section. Thinking lines
 * whose header an earlier compaction deleted cannot be told apart from their neighbours and stay.
 */
export function omitLegacyThinkingSections(text: string): string {
	const kept: string[] = [];
	let omitting = false;
	for (const line of text.split("\n")) {
		if (line.startsWith(LEGACY_THINKING_HEADER)) omitting = true;
		else if (omitting && (ROLE_HEADER_RE.test(line) || FILTERED_MARKER_RE.test(line))) omitting = false;
		if (!omitting) kept.push(line);
	}
	if (omitting && kept[kept.length - 1] === "") kept.pop();
	return kept.join("\n");
}

type MessageRole = "user" | "assistant" | "tool";
type MessageSpan = NonNullable<NumberedRegion["messageSpans"]>[number];

/**
 * Serialize the conversation since the previous boundary for extension hooks: the previous boundary's text first,
 * then each message, with each message's line span recorded.
 */
export function createConversationRegion(messages: Message[], previousSummary?: string): NumberedRegion {
	const sections: { role: MessageRole; text: string }[] = [];
	if (previousSummary) sections.push({ role: "assistant", text: previousSummary });
	for (const message of messages) {
		const text = serializeConversationForCompaction([message]);
		if (text)
			sections.push({
				role: message.role === "toolResult" ? "tool" : message.role === "user" ? "user" : "assistant",
				text,
			});
	}
	const lines: string[] = [];
	const messageSpans: MessageSpan[] = [];
	for (let index = 0; index < sections.length; index++) {
		const section = sections[index];
		const start = lines.length + 1;
		const summary = index === 0 && Boolean(previousSummary);
		lines.push(...section.text.split("\n"));
		if (index < sections.length - 1 && !summary) lines.push("");
		messageSpans.push({
			role: section.role,
			start,
			end: lines.length,
			...(summary ? { previousSummary: true } : {}),
		});
	}
	const text = lines.join("\n");
	return {
		__brand: "NumberedRegion",
		lines,
		messageSpans: messageSpans.length > 0 ? messageSpans : [{ role: "assistant", start: 1, end: 1 }],
		tokenEstimate: Math.ceil(text.length / 4),
	};
}
