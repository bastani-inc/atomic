import type { ToolCall, ToolResultMessage } from "@bastani/atomic-ai/compat";
import {
	type MessageHead,
	messageHeadIn,
	type Reader,
	read,
	readValue,
	type Shape,
	skip,
} from "../storage/session/chunked-resume-projection.js";
import { type OversizedSessionEntry, SESSION_HISTORY_CHUNK_BYTES } from "../storage/session/types.js";
import { type JsonSpan, jsonSpans, valueAt } from "./json-spans.js";
import { type captureHtmlHistory, OVERSIZED_WHOLE_BYTES, sliced } from "./session-data.js";

export type RenderCall = {
	kind: "call";
	seq: number;
	index: number;
	id: string;
	name: string;
	args: ToolCall["arguments"];
};
export type RenderResult = {
	kind: "result";
	seq: number;
	id: string;
	name: string;
	content: ToolResultMessage["content"];
	details: ToolResultMessage["details"];
	isError: boolean;
};
export const callArg = (i: number) => `arg:${i}`;

type Source = Awaited<ReturnType<typeof captureHtmlHistory>>;

/**
 * Whether an entry whose stored JSON begins with `head` can give this pass nothing: it is not a message, its role is
 * neither an assistant's nor a tool result's, or it is the result of a tool the template renders for a call no extension
 * tool made, or one without a call ID. Only fields the prefix states decide it; a stored entry repeats no key.
 */
export function neverRenderInput(head: MessageHead, builtins: ReadonlySet<string>, hasCall: (id: string) => boolean) {
	if (head.type === undefined) return false;
	if (head.type !== "message") return true;
	if (head.role === undefined) return false;
	if (head.role !== "assistant" && head.role !== "toolResult") return true;
	if (head.role === "assistant" || typeof head.toolCallId !== "string") return false;
	if (head.toolCallId === "") return true;
	return typeof head.toolName === "string" && builtins.has(head.toolName) && !hasCall(head.toolCallId);
}

/** First discover call identities without materializing content. JSON keys can precede their discriminants,
 * so a second byte pass locates only the properties that will really be exposed to a renderer. The entry's prefix is
 * read first, and is all this pass reads of an entry it can never use. One of at most OVERSIZED_WHOLE_BYTES is read
 * once and kept for this pass's readings and, while they fit, the data pass's (#5571). */
export async function oversizedRenderInputs(
	item: OversizedSessionEntry,
	source: Source,
	builtins: ReadonlySet<string>,
	hasCall: (id: string) => boolean,
): Promise<{ events: (RenderCall | RenderResult)[]; spans: Map<string, JsonSpan> }> {
	let prefix: Uint8Array = source.prefixOf(item) ?? new Uint8Array();
	if (!prefix.length)
		for await (const chunk of source.readHistoryChunks(item, 0, SESSION_HISTORY_CHUNK_BYTES)) {
			prefix = chunk;
			break;
		}
	if (neverRenderInput(messageHeadIn(prefix), builtins, hasCall))
		return { events: [], spans: new Map<string, JsonSpan>() };
	// Up to OVERSIZED_WHOLE_BYTES the entry's bytes are read once and kept, and this pass's readings come from memory;
	// a larger one's first reading continues after the prefix, and the others read the store again. The bytes are only
	// ever tokenized: a large field this pass does not expose is never decoded.
	let chunks: (offset?: number) => AsyncIterable<Uint8Array>;
	if (item.bytes <= OVERSIZED_WHOLE_BYTES) {
		const bytes = await source.readWhole(item, prefix);
		chunks = (offset = 0) => sliced(bytes, offset);
	} else {
		let first: AsyncIterable<Uint8Array> | undefined = (async function* () {
			yield prefix;
			yield* source.readHistoryChunks(item, prefix.length);
		})();
		chunks = (offset = 0) => {
			const reading = offset === 0 ? first : undefined;
			if (reading) first = undefined;
			return reading ?? source.readHistoryChunks(item, offset);
		};
	}
	const callList: { id: string; name: string; index: number }[] = [];
	const content: Shape = function* (t) {
		if (t.name !== "startArray") {
			yield* skip(t);
			return null;
		}
		callList.length = 0;
		let index = 0;
		for (let b = yield; b.name !== "endArray"; b = yield, index++) {
			const block = yield* readValue(b, { type: "short", id: "string", name: "string" });
			if (
				block &&
				typeof block === "object" &&
				!Array.isArray(block) &&
				block.type === "toolCall" &&
				typeof block.id === "string" &&
				typeof block.name === "string" &&
				!builtins.has(block.name)
			)
				callList.push({ id: block.id, name: block.name, index });
		}
		return null;
	};
	const header = (await read(
		chunks(),
		(function* (): Reader<unknown> {
			return yield* readValue(yield, {
				type: "short",
				message: { role: "short", toolCallId: "string", toolName: "string", isError: "truth", content },
			});
		})(),
	)) as { type?: string; message?: { role?: string; toolCallId?: string; toolName?: string; isError?: boolean } };
	const msg = header.message;
	const events: (RenderCall | RenderResult)[] = [];
	const paths = new Map<string, (string | number)[]>();
	if (header.type === "message" && msg?.role === "assistant")
		for (const c of callList) paths.set(callArg(c.index), ["message", "content", c.index, "arguments"]);
	if (
		header.type === "message" &&
		msg?.role === "toolResult" &&
		msg.toolCallId &&
		(!builtins.has(msg.toolName ?? "") || hasCall(msg.toolCallId))
	) {
		paths.set("content", ["message", "content"]);
		paths.set("details", ["message", "details"]);
	}
	const spans: Map<string, JsonSpan> = paths.size ? await jsonSpans(chunks(), paths) : new Map();
	const value = async (key: string) => {
		const span = spans.get(key);
		return !span ? undefined : await valueAt(chunks(span.start), span.end - span.start);
	};
	if (paths.size && msg?.role === "assistant") {
		for (const c of callList)
			events.push({
				kind: "call",
				seq: item.seq,
				...c,
				args: (await value(callArg(c.index))) as ToolCall["arguments"],
			});
	} else if (paths.size && msg?.role === "toolResult" && msg.toolCallId)
		events.push({
			kind: "result",
			seq: item.seq,
			id: msg.toolCallId,
			name: msg.toolName ?? "",
			content: (await value("content")) as ToolResultMessage["content"],
			details: (await value("details")) as ToolResultMessage["details"],
			isError: msg.isError || false,
		});
	return { events, spans };
}
