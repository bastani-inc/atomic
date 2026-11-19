import type { AgentState } from "@bastani/atomic-agent-core";
import type { ToolCall } from "@bastani/atomic-ai/compat";
import type { SessionManager } from "../session-manager.js";
import type { SessionHistoryItem } from "../storage/session/types.js";
import type { ToolHtmlRenderer } from "./index.js";

const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);

/** A single output JSON object. Entries can be larger than any page: copy their exact UTF-8 bytes directly to
 * the encoder rather than decoding the historical message or passing it through an extension's renderer. */
export async function* sessionDataBytes(
	sm: SessionManager,
	state: AgentState | undefined,
	renderer: ToolHtmlRenderer | undefined,
): AsyncGenerator<Uint8Array, void> {
	const end = sm.getLastSeq();
	const pages = sm.readHistory({ toSeq: end });
	const rendering = renderer && sm.readHistory({ toSeq: end });
	const metadata = {
		header: sm.getHeader(),
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
	};
	yield Buffer.from(JSON.stringify(metadata).slice(0, -1) + ',"entries":[');
	let first = true;
	for await (const { items } of pages) {
		let ordinary = "";
		for (const item of items) {
			const separator = first ? "" : ",";
			first = false;
			if ("entry" in item) ordinary += separator + JSON.stringify(item.entry);
			else {
				if (ordinary || separator) yield Buffer.from(ordinary + separator);
				ordinary = "";
				yield* sm.readHistoryChunks(item);
			}
		}
		if (ordinary) yield Buffer.from(ordinary);
	}
	yield Buffer.from("]");
	if (renderer && rendering) {
		let emitted = false;
		const emit = (
			id: string,
			data: { callHtml?: string; resultHtmlCollapsed?: string; resultHtmlExpanded?: string },
		) => {
			const prefix = emitted ? "," : ',"renderedTools":{';
			emitted = true;
			return Buffer.from(prefix + JSON.stringify(id) + ":" + JSON.stringify(data));
		};
		// Store only the page currently being rendered. A result belonging to an older call looks up that call
		// on demand; the render context can then be reconstructed without pinning every call's arguments.
		for await (const { items } of rendering) {
			for (const item of items) {
				if (!("entry" in item) || item.entry.type !== "message") continue;
				const message = item.entry.message;
				if (message.role === "assistant" && Array.isArray(message.content)) {
					for (const block of message.content)
						if (block.type === "toolCall" && !TEMPLATE_RENDERED_TOOLS.has(block.name)) {
							try {
								const callHtml = renderer.renderCall(block.id, block.name, block.arguments);
								if (callHtml) yield emit(block.id, { callHtml });
							} finally {
								renderer.releaseCall?.(block.id);
							}
						}
				} else if (
					message.role === "toolResult" &&
					message.toolCallId &&
					!TEMPLATE_RENDERED_TOOLS.has(message.toolName ?? "")
				) {
					const id = message.toolCallId;
					const call = findCall(items, id, item.seq) ?? (await earlierCall(sm, id, items[0]!.seq - 1));
					try {
						const initial = call && renderer.renderCall(id, call.name, call.arguments);
						const result = renderer.renderResult(
							id,
							message.toolName ?? "",
							message.content,
							message.details,
							message.isError || false,
						);
						if (result) {
							const callHtml = (call && renderer.renderCall(id, call.name, call.arguments)) ?? initial;
							yield emit(id, {
								callHtml,
								resultHtmlCollapsed: result.collapsed,
								resultHtmlExpanded: result.expanded,
							});
						}
					} finally {
						renderer.releaseCall?.(id);
					}
				}
			}
		}
		if (emitted) yield Buffer.from("}");
	}
	yield Buffer.from("}");
}

function findCall(items: readonly SessionHistoryItem[], id: string, before: number): ToolCall | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		if (item.seq >= before || !("entry" in item)) continue;
		const entry = item.entry;
		if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content))
			continue;
		const call = entry.message.content.find((b) => b.type === "toolCall" && b.id === id);
		if (call?.type === "toolCall") return call;
	}
	return undefined;
}
async function earlierCall(sm: SessionManager, id: string, toSeq: number): Promise<ToolCall | undefined> {
	let found: ToolCall | undefined;
	for await (const { items } of sm.readHistory({ toSeq })) found = findCall(items, id, toSeq + 1) ?? found;
	return found;
}

/** Base64 padding belongs only at EOF, not at page, entry or UTF-8 boundaries. */
export async function* encodeSessionData(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string, void> {
	let carry = Buffer.alloc(0);
	for await (const chunk of chunks) {
		const data = carry.length
			? Buffer.concat([carry, chunk])
			: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const through = data.length - (data.length % 3);
		if (through) yield data.toString("base64", 0, through);
		carry = Buffer.from(data.subarray(through));
	}
	if (carry.length) yield carry.toString("base64");
}
