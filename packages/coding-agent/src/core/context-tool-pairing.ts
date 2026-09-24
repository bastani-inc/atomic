import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Structural tool-pairing guard and repair for provider-bound context.
 *
 * `repairOrphanToolResults` already collapses the recoverable forms of this
 * invariant at conversion time: orphaned or duplicate `tool_result` blocks and
 * tool calls interrupted before their result was persisted. None need to reach
 * the provider.
 *
 * Some models (Kimi numbers calls `bash:0`, `bash:1`, … from zero in every
 * response) or providers (no id at all) reuse a tool call id across separate
 * assistant turns. Each turn's results follow it directly, so pairing by
 * position is unambiguous: `uniquifyToolCallIds` renames the reused ids in
 * derived context and leaves the transcript untouched.
 *
 * The same assistant turn appearing twice is a different problem. The transcript
 * itself is corrupt (#2051), so there is no safe repair — dropping either copy
 * guesses at which tool results belong to it. The provider answers that with an
 * opaque 400 that kills the turn, so fail here instead, naming the ids.
 */

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name?: unknown;
	arguments?: unknown;
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	if (!block || typeof block !== "object") return false;
	const candidate = block as { type?: unknown; id?: unknown };
	return candidate.type === "toolCall" && typeof candidate.id === "string";
}

function toolCallBlocks(message: AgentMessage): ToolCallBlock[] {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? content.filter(isToolCallBlock) : [];
}

function responseId(message: AgentMessage): string | undefined {
	const id = (message as { responseId?: unknown }).responseId;
	return typeof id === "string" && id !== "" ? id : undefined;
}

function isSameAssistantTurn(first: AgentMessage, second: AgentMessage): boolean {
	if (first === second) return true;
	const firstResponse = responseId(first);
	const secondResponse = responseId(second);
	if (firstResponse !== undefined && secondResponse !== undefined) return firstResponse === secondResponse;
	return first.timestamp === second.timestamp && JSON.stringify(first) === JSON.stringify(second);
}

export function findDuplicateToolCallIds(messages: readonly AgentMessage[]): string[] {
	const announcers = new Map<string, AgentMessage[]>();
	const duplicates = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if ((message as { excludeFromContext?: boolean }).excludeFromContext === true) continue;
		for (const id of new Set(toolCallBlocks(message).map((block) => block.id))) {
			const previous = announcers.get(id);
			if (!previous) {
				announcers.set(id, [message]);
				continue;
			}
			if (previous.some((earlier) => isSameAssistantTurn(earlier, message))) duplicates.add(id);
			previous.push(message);
		}
	}
	return [...duplicates];
}

/** Throw a descriptive error when context carries the same assistant turn more than once. */
export function assertToolPairingInvariant(messages: readonly AgentMessage[]): void {
	const duplicates = findDuplicateToolCallIds(messages);
	if (duplicates.length === 0) return;
	const plural = duplicates.length > 1;
	throw new Error(
		`Context is structurally invalid for the provider: tool call ${plural ? "ids" : "id"} ` +
			`${duplicates.join(", ")} ${plural ? "appear" : "appears"} in more than one assistant message. ` +
			"The request was not sent.",
	);
}

const EMPTY_TOOL_CALL_ID_BASE = "call";

function uniqueToolCallId(original: string, turn: number, used: ReadonlySet<string>): string {
	const base = `${original || EMPTY_TOOL_CALL_ID_BASE}_${turn}`;
	let candidate = base;
	for (let attempt = 1; used.has(candidate); attempt++) candidate = `${base}_${attempt}`;
	return candidate;
}

function needsToolCallRename(blocks: readonly ToolCallBlock[], used: ReadonlySet<string>): boolean {
	const seen = new Set<string>();
	for (const { id } of blocks) {
		if (id === "" || used.has(id) || seen.has(id)) return true;
		seen.add(id);
	}
	return false;
}

/**
 * Give every tool call a non-empty id that no earlier call in the context uses.
 *
 * A reused or empty id is renamed after its assistant turn, and the tool results
 * following that turn (up to the next assistant message) are renamed with it in
 * call order. Renaming depends only on earlier messages, so the derived ids stay
 * stable as the conversation grows and do not invalidate provider prompt caches.
 * Messages that need no change are returned as the same objects.
 */
export function uniquifyToolCallIds<TMessage extends AgentMessage>(messages: TMessage[]): TMessage[] {
	const used = new Set<string>();
	let renamedResultIds: Map<string, string[]> | undefined;
	let changed = false;
	let turn = 0;
	const uniquified = messages.map((message): TMessage => {
		if (message.role === "assistant") {
			turn++;
			renamedResultIds = undefined;
			const blocks = toolCallBlocks(message);
			if (!needsToolCallRename(blocks, used)) {
				for (const block of blocks) used.add(block.id);
				return message;
			}
			const pairing = new Map<string, string[]>();
			const content = (message as { content: unknown[] }).content.map((block) => {
				if (!isToolCallBlock(block)) return block;
				const id = block.id !== "" && !used.has(block.id) ? block.id : uniqueToolCallId(block.id, turn, used);
				used.add(id);
				pairing.set(block.id, [...(pairing.get(block.id) ?? []), id]);
				return id === block.id ? block : { ...block, id };
			});
			renamedResultIds = pairing;
			changed = true;
			return { ...message, content } as TMessage;
		}
		if (message.role !== "toolResult" || !renamedResultIds) return message;
		const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
		if (typeof toolCallId !== "string") return message;
		const id = renamedResultIds.get(toolCallId)?.shift();
		if (id === undefined || id === toolCallId) return message;
		return { ...message, toolCallId: id } as TMessage;
	});
	return changed ? uniquified : messages;
}
