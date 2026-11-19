import { isProxy } from "node:util/types";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { isProducedByModel } from "@bastani/atomic-ai/api/transform-messages";
import type { Api, Message, Model } from "@bastani/atomic-ai/compat";
import type { SessionEntry, SessionHeader } from "./session-manager-types.ts";

/** Internal capability passed with the built-in child filter, including across separately loaded packages. */
export const forkReplayFilter = Symbol.for("atomic.subagents/fork-replay-filter@1");
export interface ForkReplayFilter {
	project: (messages: AgentMessage[]) => AgentMessage[];
	boundary: (message: AgentMessage) => "visible" | "hidden" | undefined;
}

/** Fork provenance is stored as data. A virtual host's optional accessors are not a receipt. */
export function isForkHeader(header: SessionHeader | null | undefined): header is SessionHeader {
	return (
		!!header &&
		!isProxy(header) &&
		typeof Object.getOwnPropertyDescriptor(header, "parentSessionId")?.value === "string"
	);
}

export interface ForkReplayPair {
	earlier: WeakRef<Message>;
	later: WeakRef<Message>;
}

export function acceptsForkReplay(model: Model<Api>): boolean {
	// An optional SDK route may be late-bound. Only native data properties confer this authority;
	// a proxy/accessor keeps normal behavior and is never executed just to decide eligibility.
	if (isProxy(model) || Object.getPrototypeOf(model) !== Object.prototype) return false;
	const api = Object.getOwnPropertyDescriptor(model, "api")?.value;
	const provider = Object.getOwnPropertyDescriptor(model, "provider")?.value;
	if (api !== "anthropic-messages" || !["github-copilot", "anthropic", "anthropic-api"].includes(provider))
		return false;
	const route = Object.getOwnPropertyDescriptor(model, "fastRoute");
	if (route && !("value" in route)) return false;
	const fast = route?.value;
	if (fast && (typeof fast !== "object" || isProxy(fast) || Object.getPrototypeOf(fast) !== Object.prototype))
		return false;
	const upstream = fast && Object.getOwnPropertyDescriptor(fast, "upstreamModelId");
	if (upstream && !("value" in upstream)) return false;
	const id = upstream?.value ?? Object.getOwnPropertyDescriptor(model, "id")?.value;
	return typeof id === "string" && id.startsWith("claude-");
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

// An opening receipt is local: two answers, their boundary, and a short tail of tool/aborted
// turns and fork metadata. Longer or ambiguous layouts are ordinary history, not a reason to
// search the transcript at session creation. This limit does not truncate any model input.
const OPENING_TAIL_SLOTS = 8;

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
	const floor = Math.max(0, branch.length - OPENING_TAIL_SLOTS);
	for (let i = branch.length - 1; i >= floor; i--) {
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
	const floor = Math.max(0, projected.length - OPENING_TAIL_SLOTS);
	let right = projected.length - 1;
	while (right >= floor && !hasContent(projected[right], destination)) {
		const role = projected[right].role;
		if (role !== "assistant" && role !== "toolResult") return undefined;
		right--;
	}
	if (right < floor) return undefined;
	const rightBlock = firstBlock(projected[right]);
	if (!leadsWithThinking(rightBlock)) return undefined;
	let left = right - 1;
	while (left >= floor && !hasContent(projected[left], destination)) {
		// A caller that later hides a surviving user or tool result creates its own join.
		if (projected[left].role !== "assistant") return undefined;
		left--;
	}
	if (left < floor) return undefined;
	const leftBlock = firstBlock(projected[left]);
	if (!leadsWithThinking(leftBlock) || leftBlock === rightBlock) return undefined;

	// Removing a subagent call may copy the assistant, but preserves its thinking block.
	const rawFloor = Math.max(0, raw.length - OPENING_TAIL_SLOTS);
	let rawRight = raw.length - 1;
	while (rawRight >= rawFloor && firstBlock(raw[rawRight]) !== rightBlock) rawRight--;
	let rawLeft = rawRight - 1;
	while (rawLeft >= rawFloor && firstBlock(raw[rawLeft]) !== leftBlock) rawLeft--;
	if (rawLeft < rawFloor) return undefined;
	let gap = rawLeft + 1;
	for (; gap < rawRight; gap++) {
		const row = raw[gap];
		// Only a single in-flight call is a local hidden row; do not classify arbitrary block lists.
		if (row.role === "assistant" && row.content?.length !== 1) return undefined;
		const boundary = filter.boundary(row);
		if (boundary === "visible") break;
		if (boundary !== "hidden") return undefined;
	}
	if (gap === rawRight) return undefined;
	const gapRole = raw[gap].role;
	const gapId = removedEntryId(branch, raw[gap], leftBlock, rightBlock);
	if (!gapId) return undefined;

	// The normal live layout adds one leading effective system row. If folding an unusual
	// historical system layout moves the pair elsewhere, decline rather than walking the prefix.
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
				input[gap].role === gapRole &&
				filter.boundary(input[gap]) === "visible"
			);
		},
		converted(input: AgentMessage[], normalized: (Message | undefined)[]): ForkReplayPair | undefined {
			const direct = stillPaired(input, left, right);
			if (!direct && (input[0]?.role !== "system" || !stillPaired(input, left + 1, right + 1))) return undefined;
			const offset = direct ? 0 : 1;
			const earlier = normalized[left + offset];
			const later = normalized[right + offset];
			return earlier && later ? { earlier: new WeakRef(earlier), later: new WeakRef(later) } : undefined;
		},
	};
}
