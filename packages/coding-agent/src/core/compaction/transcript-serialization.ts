import type { ImageContent, Message, TextContent } from "@bastani/pi-ai/compat";
import type { LineRange, NumberedRegion } from "./compaction-types.js";

export const FILTERED_MARKER_RE = /^\(filtered (\d+) lines\)$/;
export const LINE_NUMBER_SEPARATOR = "→";
export const ROLE_HEADER_RE = /^\[(User|Assistant|Assistant tool calls|Tool result)\]: /;

/**
 * Header of the thinking section that transcripts serialized before prompt version 5 carried.
 * Current transcripts never emit it; it is recognized only to drop those sections from older summaries.
 */
const LEGACY_THINKING_HEADER = "[Assistant thinking]: ";

/**
 * Callers wrap never-compressible content in `<keepContext>` / `</keepContext>`. Every line of
 * such a span, tag lines included, becomes a protected line, so the span survives verbatim
 * regardless of the compression ratio. Protecting the tags themselves is what makes the span
 * re-detectable on the next boundary, since each compaction re-ranks the previous output.
 *
 * The region is untrusted: it is serialized user, assistant, and tool-result payload, and a
 * message may quote or document the tag text. Detection is therefore deliberately narrow — a
 * marker must be the entire line once an optional role header is stripped, and only a matched
 * open/close pair protects anything. Prose that merely mentions a tag matches nothing, and an
 * unmatched opener protects nothing rather than swallowing the rest of the region.
 */
const KEEP_CONTEXT_OPEN_LINE_RE = /^<keepContext>$/i;
const KEEP_CONTEXT_CLOSE_LINE_RE = /^<\/keepContext>$/i;

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

export function filteredMarker(lineCount: number): string {
	return `(filtered ${lineCount} lines)`;
}

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

/**
 * Classify a line as a `keepContext` marker.
 *
 * The serializer prefixes the first line of a message with its role header, so a span opened at
 * the start of a stage prompt arrives as `[User]: <keepContext>`. The header is stripped before
 * matching, and the remainder must be the whole line — prose that mentions a tag mid-sentence is
 * payload, not syntax.
 */
function keepContextMarker(line: string): "open" | "close" | undefined {
	const body = line.replace(ROLE_HEADER_RE, "").trim();
	if (KEEP_CONTEXT_OPEN_LINE_RE.test(body)) return "open";
	if (KEEP_CONTEXT_CLOSE_LINE_RE.test(body)) return "close";
	return undefined;
}

/** Message roles whose payload is external, so its tag text is data rather than syntax. */
const UNTRUSTED_MARKER_ROLE = "Tool result";

/**
 * Whether a message role may declare protection.
 *
 * User and assistant messages both may. Prompt construction — stage prompts, run inputs, and
 * steering — arrives as user messages, and agents need protection in their own output too, to
 * restate a contract amendment in a handoff report or pin a decision that changes later
 * behavior. A user-only rule would make those inert while still looking correct at the call site.
 *
 * Tool results may not. Their payload is file contents, fetched pages, and command output —
 * bytes an attacker can choose — and honoring tags there would let read material mark itself
 * unreclaimable and persist through compaction ahead of real transcript content. An agent that
 * wants to keep something it read can restate it in its own message, which is also the more
 * selective habit.
 *
 * An undefined role is the prior compaction summary prepended ahead of the first role header.
 * That is compaction's own output, and honoring it is what lets a span re-arm on later
 * boundaries after its header line has itself been compacted away.
 */
function roleMayProtect(role: string | undefined): boolean {
	return role !== UNTRUSTED_MARKER_ROLE;
}

/** One `<keepContext>` span: its one-based inclusive lines, tag lines included. */
export interface KeepContextSpan extends LineRange {
	/** One-based line of the role header that starts the span's message; undefined before the first header. */
	messageHeaderLine: number | undefined;
}

/**
 * The `<keepContext>` spans of a region, oldest first, each inclusive of its tag lines.
 *
 * Spans are scoped to a single message: a role header ends any span still open, and an unclosed
 * span protects through the end of its own message rather than the end of the region. Together
 * with the whole-line marker rule and the tool-result exclusion, that keeps the permissive
 * unclosed case safe — quoted or injected tag text costs at most its own message instead of
 * everything after it. Compaction that cannot reclaim is an overflow, not a safe failure.
 *
 * Nested openers flatten into the outermost span, and a closing tag with no opener is inert.
 */
export function keepContextSpans(lines: readonly string[]): KeepContextSpan[] {
	const spans: KeepContextSpan[] = [];
	let openIndex: number | undefined;
	let role: string | undefined;
	let headerLine: number | undefined;
	const closeThrough = (endIndex: number): void => {
		if (openIndex === undefined) return;
		spans.push({
			start: openIndex + 1,
			end: endIndex + 1,
			messageHeaderLine: headerLine,
		});
		openIndex = undefined;
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const header = ROLE_HEADER_RE.exec(line);
		if (header) {
			closeThrough(index - 1);
			role = header[1];
			headerLine = index + 1;
		}
		if (!roleMayProtect(role)) continue;
		const marker = keepContextMarker(line);
		if (marker === "open") {
			if (openIndex === undefined) openIndex = index;
			continue;
		}
		if (marker === "close") closeThrough(index);
	}
	closeThrough(lines.length - 1);
	return spans;
}

/**
 * The text a span protects with its tags and role header removed and whitespace collapsed, so
 * two restatements of the same constraint compare equal.
 */
export function keepContextSpanKey(lines: readonly string[], span: LineRange): string {
	return lines
		.slice(span.start - 1, span.end)
		.filter((line) => keepContextMarker(line) === undefined)
		.map((line) => line.replace(ROLE_HEADER_RE, ""))
		.join("\n")
		.replace(/\s+/g, " ")
		.trim();
}

/** One-based line numbers covered by `<keepContext>` spans, inclusive of the tag lines. */
export function keepContextLineNumbers(lines: readonly string[]): Set<number> {
	const protectedLines = new Set<number>();
	for (const span of keepContextSpans(lines)) {
		for (let line = span.start; line <= span.end; line++) protectedLines.add(line);
	}
	return protectedLines;
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
	const detected = keepContextLineNumbers(lines);
	const merged =
		protectedLineNumbers === undefined ? detected : new Set<number>([...protectedLineNumbers, ...detected]);
	return {
		__brand: "NumberedRegion",
		lines,
		headerLineNumbers,
		priorMarkerNs,
		protectedLineNumbers: merged.size > 0 ? merged : undefined,
		tokenEstimate: Math.ceil(text.length / 4),
	};
}

export function createConversationRegion(
	messages: Message[],
	previousSummary?: string,
	locators?: FullOutputLocators,
): NumberedRegion {
	const sections: { role: "user" | "assistant" | "tool"; text: string }[] = [];
	if (previousSummary) sections.push({ role: "assistant", text: previousSummary });
	for (const message of messages) {
		const text = serializeConversationForCompaction([message], locators);
		if (text)
			sections.push({
				role: message.role === "toolResult" ? "tool" : message.role === "user" ? "user" : "assistant",
				text,
			});
	}
	const lines: string[] = [];
	const messageSpans: NonNullable<NumberedRegion["messageSpans"]> = [];
	for (let index = 0; index < sections.length; index++) {
		const section = sections[index];
		const start = lines.length + 1;
		lines.push(...section.text.split("\n"));
		if (index < sections.length - 1 && !(index === 0 && previousSummary)) lines.push("");
		messageSpans.push({ role: section.role, start, end: lines.length });
	}
	const region = createNumberedRegion(lines.join("\n"));
	region.messageSpans = messageSpans.length > 0 ? messageSpans : [{ role: "assistant", start: 1, end: 1 }];
	return region;
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
