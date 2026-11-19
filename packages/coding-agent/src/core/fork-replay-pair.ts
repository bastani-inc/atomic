import type { AgentMessage } from "@bastani/atomic-agent-core";
import { isProducedByModel } from "@bastani/atomic-ai/api/transform-messages";
import type { Api, Message, Model } from "@bastani/atomic-ai/compat";
import type { SessionEntry } from "./session-manager-types.ts";

/** Internal capability passed with the built-in child filter, including across separately loaded packages. */
export const forkReplayFilter = Symbol.for("atomic.subagents/fork-replay-filter@1");
export interface ForkReplayFilter {
	project: (messages: AgentMessage[]) => AgentMessage[];
	boundary: (message: AgentMessage) => "visible" | "hidden" | undefined;
}

export interface ForkReplayPair {
	earlier: WeakRef<Message>;
	later: WeakRef<Message>;
}

export function acceptsForkReplay(model: Model<Api>): boolean {
	return (
		model.api === "anthropic-messages" &&
		(model.provider === "github-copilot" || model.provider === "anthropic" || model.provider === "anthropic-api") &&
		(model.fastRoute?.upstreamModelId ?? model.id).startsWith("claude-")
	);
}

type Assistant = Extract<AgentMessage, { role: "assistant" }>;
function hasContent(message: AgentMessage, destination: Model<Api> | undefined): message is Assistant {
	if (
		message.role !== "assistant" ||
		message.stopReason === "aborted" ||
		message.stopReason === "error" ||
		!message.content?.length
	)
		return false;
	// Foreign reasoning may emit no assistant at all. The wire guard independently checks
	// the actual latest emitted pair, including a foreign answer that does emit visible text.
	const type: string = message.content[0]?.type;
	return (
		(type !== "thinking" && type !== "redacted_thinking") ||
		(destination ? isProducedByModel(message, destination) : message.api === "anthropic-messages")
	);
}

function firstBlock(message: AgentMessage | undefined) {
	return message?.role === "assistant" ? message.content?.[0] : undefined;
}

function leadsWithThinking(block: unknown): block is object {
	if (!block || typeof block !== "object" || !("type" in block)) return false;
	return block.type === "thinking"
		? "thinkingSignature" in block &&
				typeof block.thinkingSignature === "string" &&
				block.thinkingSignature.length > 0
		: block.type === "redacted_thinking" &&
				"data" in block &&
				typeof block.data === "string" &&
				block.data.length > 0;
}

/** Custom notices are rematerialized by the session manager. Identify the durable entry
 * between these two original turns, not any other notice with similar contents. */
function removedEntryId(
	branch: readonly SessionEntry[],
	gap: AgentMessage,
	left: object,
	right: object,
): string | undefined {
	let withinPair = false;
	let id: string | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		const block = entry.type === "message" ? firstBlock(entry.message) : undefined;
		if (!withinPair) {
			withinPair = block === right;
			continue;
		}
		if (block === left) return id;
		if (
			(entry.type === "message" && entry.message === gap) ||
			(entry.type === "custom_message" &&
				gap.role === "custom" &&
				entry.customType === gap.customType &&
				entry.content === gap.content &&
				Date.parse(entry.timestamp) === gap.timestamp)
		) {
			if (id !== undefined) return undefined;
			id = entry.id;
		}
	}
	return undefined;
}

/** Locate just the fork's opening pair once. Requests check its original slots, not the history. */
export function captureForkReplayPair(
	raw: AgentMessage[],
	projected: AgentMessage[],
	filter: ForkReplayFilter,
	branch: readonly SessionEntry[],
	destination: Model<Api> | undefined,
) {
	const right = projected.findLastIndex((message) => hasContent(message, destination));
	const rightBlock = firstBlock(projected[right]);
	if (!leadsWithThinking(rightBlock)) return undefined;
	let left = right - 1;
	while (left >= 0 && !hasContent(projected[left], destination)) {
		// A caller that later hides a surviving user or tool result creates its own join.
		if (projected[left].role !== "assistant") return undefined;
		left--;
	}
	const leftBlock = firstBlock(projected[left]);
	if (!leadsWithThinking(leftBlock) || leftBlock === rightBlock) return undefined;

	// Removing a subagent call may copy the assistant, but preserves its thinking block.
	const rawRight = raw.findLastIndex((m) => firstBlock(m) === rightBlock);
	let rawLeft = rawRight - 1;
	while (rawLeft >= 0 && firstBlock(raw[rawLeft]) !== leftBlock) rawLeft--;
	if (rawLeft < 0) return undefined;
	let gap = rawLeft + 1;
	while (gap < rawRight && filter.boundary(raw[gap]) === "hidden") gap++;
	if (gap >= rawRight || filter.boundary(raw[gap]) !== "visible") return undefined;
	const gapId = removedEntryId(branch, raw[gap], leftBlock, rightBlock);
	if (!gapId) return undefined;

	// The live session folds system messages into a single leading row; direct SDK
	// conversion may instead receive the original projection. Save both layouts once.
	let foldedLeft = left + 1;
	let foldedRight = right + 1;
	for (let i = 0; i < right; i++) {
		if (projected[i].role !== "system") continue;
		if (i < left) foldedLeft--;
		foldedRight--;
	}
	const originalLeft = new WeakRef(leftBlock);
	const originalRight = new WeakRef(rightBlock);
	function stillPaired(messages: AgentMessage[], l: number, r: number): boolean {
		const a = originalLeft.deref();
		const b = originalRight.deref();
		return !!a && !!b && firstBlock(messages[l]) === a && firstBlock(messages[r]) === b;
	}
	return {
		matches(input: AgentMessage[], output: AgentMessage[], ids: WeakMap<object, string>) {
			return (
				stillPaired(input, rawLeft, rawRight) &&
				stillPaired(output, left, right) &&
				ids.get(input[gap]) === gapId &&
				filter.boundary(input[gap]) === "visible"
			);
		},
		converted(input: AgentMessage[], normalized: (Message | undefined)[]): ForkReplayPair | undefined {
			const direct = stillPaired(input, left, right);
			if (!direct && (input[0]?.role !== "system" || !stillPaired(input, foldedLeft, foldedRight))) return undefined;
			const earlier = normalized[direct ? left : foldedLeft];
			const later = normalized[direct ? right : foldedRight];
			return earlier && later ? { earlier: new WeakRef(earlier), later: new WeakRef(later) } : undefined;
		},
	};
}
