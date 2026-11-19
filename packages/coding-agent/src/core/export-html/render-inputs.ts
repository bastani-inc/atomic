import type { ToolCall, ToolResultMessage } from "@bastani/atomic-ai/compat";
import type { SessionEntry } from "../session-manager.ts";
import type { SessionToolUseSelection } from "../storage/session/types.js";
import type { ToolHtmlRenderer } from "./index.ts";
import { editsFor, type JsonSpan } from "./json-spans.js";
import type { captureHtmlHistory } from "./session-data.js";

const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);
/**
 * The entries this pass can read: tool results, and assistant messages with a call of a tool the template does not
 * render, besides entries larger than a page. A store skips every other entry for this pass (#5571).
 */
export const RENDER_INPUT_SELECTION: SessionToolUseSelection = { exceptCalls: [...TEMPLATE_RENDERED_TOOLS] };

type Call = { kind: "call"; seq: number; index: number; id: string; name: string; args: ToolCall["arguments"] };
type Result = {
	kind: "result";
	seq: number;
	id: string;
	name: string;
	content: ToolResultMessage["content"];
	details: ToolResultMessage["details"];
	isError: boolean;
};
type Rendered = { callHtml?: string; resultHtmlCollapsed?: string; resultHtmlExpanded?: string };

/** An extension can keep and mutate a previous call's arguments or result while rendering a different call.
 * Retain those exposed inputs until the export is serialized. Do not retain other message blocks or history. */
export async function renderHtmlInputs(
	source: Awaited<ReturnType<typeof captureHtmlHistory>>,
	renderer: ToolHtmlRenderer,
) {
	const events: (Call | Result)[] = [];
	const lastUse = new Map<string, number>();
	const oversized = new Map<number, Map<string, JsonSpan>>();
	for await (const { items } of source.readHistory(RENDER_INPUT_SELECTION)) {
		for (const item of items) {
			if (!("entry" in item)) {
				const { oversizedRenderInputs } = await import("./oversized-render-inputs.js");
				const h = await oversizedRenderInputs(item, source, TEMPLATE_RENDERED_TOOLS, (id) => lastUse.has(id));
				if (h.spans.size) oversized.set(item.seq, h.spans);
				for (const event of h.events) {
					lastUse.set(event.id, events.length);
					events.push(event);
				}
				continue;
			}
			if (item.entry.type !== "message") continue;
			const message = item.entry.message;
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const [index, block] of message.content.entries()) {
					if (block.type !== "toolCall" || TEMPLATE_RENDERED_TOOLS.has(block.name)) continue;
					lastUse.set(block.id, events.length);
					events.push({
						kind: "call",
						seq: item.seq,
						index,
						id: block.id,
						name: block.name,
						args: block.arguments,
					});
				}
			} else if (
				message.role === "toolResult" &&
				message.toolCallId &&
				(!TEMPLATE_RENDERED_TOOLS.has(message.toolName ?? "") || lastUse.has(message.toolCallId))
			) {
				lastUse.set(message.toolCallId, events.length);
				events.push({
					kind: "result",
					seq: item.seq,
					id: message.toolCallId,
					name: message.toolName ?? "",
					content: message.content,
					details: message.details,
					isError: message.isError || false,
				});
			}
		}
	}
	const calls = new Map<string, Call>();
	const rendered = new Map<string, Rendered>();
	const argumentsAt = new Map<number, Map<number, ToolCall["arguments"]>>();
	const resultAt = new Map<number, Result>();
	const active = new Set<string>();
	// The callback phase is synchronous just as it is for a snapshot: not even crossing a stored page inserts
	// a microtask between calls. A rerender after a result uses the original arguments, never a reconstructed call.
	try {
		for (const [i, event] of events.entries()) {
			const { id } = event;
			if (event.kind === "call") {
				active.add(id);
				calls.set(id, event);
				const at = argumentsAt.get(event.seq) ?? new Map<number, ToolCall["arguments"]>();
				at.set(event.index, event.args);
				argumentsAt.set(event.seq, at);
				const callHtml = renderer.renderCall(id, event.name, event.args);
				if (callHtml) rendered.set(id, { callHtml });
			} else if (rendered.has(id) || !TEMPLATE_RENDERED_TOOLS.has(event.name)) {
				active.add(id);
				resultAt.set(event.seq, event);
				const result = renderer.renderResult(id, event.name, event.content, event.details, event.isError);
				if (result) {
					const call = calls.get(id);
					const callHtml = call && renderer.renderCall(id, call.name, call.args);
					rendered.set(id, {
						...rendered.get(id),
						...(callHtml !== undefined ? { callHtml } : {}),
						resultHtmlCollapsed: result.collapsed,
						resultHtmlExpanded: result.expanded,
					});
				}
			}
			if (lastUse.get(id) === i) {
				calls.delete(id);
				if (active.delete(id)) renderer.releaseCall?.(id);
			}
		}
	} finally {
		for (const id of active) renderer.releaseCall?.(id);
	}
	return {
		rendered,
		oversizedPatches(seq: number) {
			const spans = oversized.get(seq);
			if (!spans) return;
			const values: { span: JsonSpan; json: string | undefined }[] = [];
			const add = (key: string, value: unknown) => {
				const span = spans.get(key);
				if (span) values.push({ span, json: JSON.stringify(value) });
			};
			for (const [i, args] of argumentsAt.get(seq) ?? []) add(`arg:${i}`, args);
			const r = resultAt.get(seq);
			if (r) {
				add("content", r.content);
				add("details", r.details);
			}
			return editsFor(values);
		},
		/** Main serializes the whole export at one point. Take that cut only for values an extension could
		 * have mutated; unrelated rows remain in the durable store and never enter this snapshot. */
		freezeInputs(): void {
			const seqs = [...argumentsAt.keys(), ...resultAt.keys()].sort((a, b) => a - b);
			for (const seq of seqs) {
				const at = argumentsAt.get(seq);
				if (at)
					for (const [index, args] of at) {
						const copy = JSON.parse(JSON.stringify({ arguments: args })) as { arguments: ToolCall["arguments"] };
						at.set(index, copy.arguments);
					}
				const result = resultAt.get(seq);
				if (result) {
					const copy = JSON.parse(JSON.stringify({ content: result.content, details: result.details })) as Pick<
						Result,
						"content" | "details"
					>;
					resultAt.set(seq, { ...result, content: copy.content, details: copy.details });
				}
			}
		},
		/** Restore precisely the mutable inputs passed to this export's renderers to a freshly read durable row. */
		entry(seq: number, raw: SessionEntry): SessionEntry {
			if (raw.type !== "message") return raw;
			const message = raw.message;
			const at = argumentsAt.get(seq);
			if (at && message.role === "assistant")
				return {
					...raw,
					message: {
						...message,
						content: message.content.map((block, index) =>
							block.type === "toolCall" && at.has(index) ? { ...block, arguments: at.get(index)! } : block,
						),
					},
				};
			const result = resultAt.get(seq);
			return result && message.role === "toolResult"
				? { ...raw, message: { ...message, content: result.content, details: result.details } }
				: raw;
		},
	};
}
