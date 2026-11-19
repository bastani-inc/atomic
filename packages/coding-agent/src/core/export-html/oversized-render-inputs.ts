import type { ToolCall, ToolResultMessage } from "@bastani/atomic-ai/compat";
import { type Reader, read, readValue, type Shape, skip } from "../storage/session/chunked-resume-projection.js";
import type { OversizedSessionEntry } from "../storage/session/types.js";
import { type JsonSpan, jsonSpans, valueAt } from "./json-spans.js";
import type { captureHtmlHistory } from "./session-data.js";

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
/** First discover call identities without materializing content. JSON keys can precede their discriminants,
 * so a second byte pass locates only the properties that will really be exposed to a renderer. */
export async function oversizedRenderInputs(
	item: OversizedSessionEntry,
	source: Source,
	builtins: ReadonlySet<string>,
	hasCall: (id: string) => boolean,
) {
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
		source.readHistoryChunks(item),
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
	const spans: Map<string, JsonSpan> = paths.size ? await jsonSpans(source.readHistoryChunks(item), paths) : new Map();
	const value = async (key: string) => {
		const span = spans.get(key);
		return !span ? undefined : await valueAt(source.readHistoryChunks(item, span.start), span.end - span.start);
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
