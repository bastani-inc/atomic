import { isProxy } from "node:util/types";
import { anthropicAssistantReplayContent } from "@bastani/atomic-ai/api/anthropic-assistant-content";
import { isProducedByModel } from "@bastani/atomic-ai/api/transform-messages";
import type { Api, AssistantMessage, Message, Model } from "@bastani/atomic-ai/compat";

import { acceptsForkReplay, type ForkReplayPair } from "./fork-replay-pair.ts";

type JsonObject = Record<string, unknown>;

type AnthropicContentBlock = JsonObject & { type: string };

type ReplayThinkingBlock =
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicContentBlock(value: unknown): value is AnthropicContentBlock {
	return isObject(value) && typeof value.type === "string";
}

function isThinkingLikeAnthropicBlock(value: unknown): boolean {
	if (!isAnthropicContentBlock(value)) return false;
	return value.type === "thinking" || value.type === "redacted_thinking";
}

/**
 * Index of the last server-side fallback marker, or -1.
 *
 * pi-ai drops `thinking`, `redacted_thinking`, and client-side `tool_use` that precede the final
 * marker, because "a request that echoes thinking blocks from both sides of the boundary is
 * rejected". Both the alignment check and the repair pass must apply the same rule, or repair
 * would splice pre-boundary thinking back into a request the API rejects.
 * https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
 */
function finalFallbackBoundaryIndex(content: readonly unknown[]): number {
	for (let index = content.length - 1; index >= 0; index -= 1) {
		const block = content[index];
		if (isObject(block) && block.type === "fallback") return index;
	}
	return -1;
}

function readReplayThinkingBlock(block: unknown, allowEmptySignature = false): ReplayThinkingBlock | undefined {
	if (!isObject(block) || typeof block.type !== "string") return undefined;

	if (block.type === "redacted_thinking") {
		return typeof block.data === "string" ? { type: "redacted_thinking", data: block.data } : undefined;
	}

	if (block.type !== "thinking") return undefined;

	if (block.redacted === true) {
		return typeof block.thinkingSignature === "string"
			? { type: "redacted_thinking", data: block.thinkingSignature }
			: undefined;
	}

	if (typeof block.thinking !== "string" || typeof block.thinkingSignature !== "string") return undefined;
	if (!allowEmptySignature && block.thinkingSignature.trim().length === 0) return undefined;
	return { type: "thinking", thinking: block.thinking, signature: block.thinkingSignature };
}

function isSignedWireBlock(block: unknown): boolean {
	if (!isObject(block)) return false;
	const signature =
		block.type === "thinking" ? block.signature : block.type === "redacted_thinking" ? block.data : undefined;
	return typeof signature === "string" && signature.trim().length > 0;
}

function hasReplayThinkingBlock(message: AssistantMessage, allowEmptySignature: boolean): boolean {
	return message.content.some((block) => readReplayThinkingBlock(block, allowEmptySignature) !== undefined);
}

/**
 * Whether the provider payload holds an assistant message for this turn, answered by pi-ai's own
 * `transformMessages` pass and Anthropic block conversion so the ordinal mapping cannot drift from
 * the payload. A turn left with nothing to send is omitted, such as a GPT turn that held only
 * reasoning. A retained server-side `fallback` marker is always sent, even when it is the only
 * block left because the turn's reasoning belongs to other models.
 */
function providerEmitsAssistant(message: AssistantMessage, model: Model<Api>): boolean {
	return anthropicAssistantReplayContent(message, model).length > 0;
}

function fallbackTextBlock(block: JsonObject): AnthropicContentBlock | undefined {
	return typeof block.text === "string" && block.text.trim().length > 0
		? { type: "text", text: block.text }
		: undefined;
}

function fallbackToolUseBlock(block: JsonObject): AnthropicContentBlock | undefined {
	if (typeof block.id !== "string" || typeof block.name !== "string") return undefined;
	return { type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} };
}

function takeProviderBlock(
	providerBlocks: readonly AnthropicContentBlock[],
	providerIndex: number,
	expectedType: string,
): { block: AnthropicContentBlock | undefined; nextProviderIndex: number } {
	const providerBlock = providerBlocks[providerIndex];
	if (providerBlock?.type === expectedType) {
		return { block: providerBlock, nextProviderIndex: providerIndex + 1 };
	}
	return { block: undefined, nextProviderIndex: providerIndex };
}

function nonThinkingBlocksAlign(message: AssistantMessage, providerBlocks: readonly AnthropicContentBlock[]): boolean {
	const boundaryIndex = finalFallbackBoundaryIndex(message.content);
	const sourceTypes = message.content.flatMap((block, index) => {
		if (!isObject(block) || typeof block.type !== "string") return [];
		if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0 ? ["text"] : [];
		// The marker is replayed in place and is not thinking-like, so it survives the provider-side
		// filter below and both sides must count it.
		if (block.type === "fallback") return ["fallback"];
		if (block.type !== "toolCall") return [];
		// A client-side tool call before the final marker was never executed by the model that
		// continued the turn, so pi-ai drops it along with its tool result.
		return boundaryIndex >= 0 && index < boundaryIndex ? [] : ["tool_use"];
	});
	const providerTypes = providerBlocks
		.filter((block) => !isThinkingLikeAnthropicBlock(block))
		.map((block) => block.type);
	return (
		sourceTypes.length === providerTypes.length && sourceTypes.every((type, index) => type === providerTypes[index])
	);
}

function repairAssistantContent(
	originalMessage: AssistantMessage,
	providerBlocks: readonly AnthropicContentBlock[],
	allowEmptySignature: boolean,
): AnthropicContentBlock[] {
	const repaired: AnthropicContentBlock[] = [];
	let providerIndex = 0;

	// `fallbackTextBlock`/`fallbackToolUseBlock` below mean "fallback value"; `boundaryIndex` is the
	// unrelated Anthropic server-side fallback marker.
	const boundaryIndex = finalFallbackBoundaryIndex(originalMessage.content);

	for (const [index, originalBlock] of originalMessage.content.entries()) {
		const precedesBoundary = boundaryIndex >= 0 && index < boundaryIndex;
		// Thinking before the final marker is not in the payload and must not be restored into it:
		// echoing thinking from both sides of the boundary is rejected outright.
		const replayBlock = precedesBoundary ? undefined : readReplayThinkingBlock(originalBlock, allowEmptySignature);
		if (replayBlock) {
			if (isThinkingLikeAnthropicBlock(providerBlocks[providerIndex])) {
				providerIndex += 1;
			}
			repaired.push({ ...replayBlock });
			continue;
		}

		if (!isObject(originalBlock) || typeof originalBlock.type !== "string") continue;

		if (originalBlock.type === "fallback") {
			// Replayed in place, straight from the payload: this guard only restores thinking, and
			// the marker's position is what the API validates the surrounding thinking against.
			const providerMarker = takeProviderBlock(providerBlocks, providerIndex, "fallback");
			if (providerMarker.block) {
				repaired.push(providerMarker.block);
				providerIndex = providerMarker.nextProviderIndex;
			}
			continue;
		}

		if (originalBlock.type === "text") {
			const providerText = takeProviderBlock(providerBlocks, providerIndex, "text");
			if (providerText.block) {
				repaired.push(providerText.block);
				providerIndex = providerText.nextProviderIndex;
				continue;
			}
			const fallback = fallbackTextBlock(originalBlock);
			if (fallback) repaired.push(fallback);
			continue;
		}

		if (originalBlock.type === "toolCall") {
			// Dropped by pi-ai alongside its tool result, because the declining model's call was
			// never executed by the model that continued.
			if (precedesBoundary) continue;
			const providerToolUse = takeProviderBlock(providerBlocks, providerIndex, "tool_use");
			if (providerToolUse.block) {
				repaired.push(providerToolUse.block);
				providerIndex = providerToolUse.nextProviderIndex;
				continue;
			}
			const fallback = fallbackToolUseBlock(originalBlock);
			if (fallback) repaired.push(fallback);
		}
	}

	for (; providerIndex < providerBlocks.length; providerIndex += 1) {
		repaired.push(providerBlocks[providerIndex]);
	}

	return repaired;
}

function getAnthropicMessages(payload: unknown): unknown[] | undefined {
	if (!isObject(payload)) return undefined;
	return Array.isArray(payload.messages) ? payload.messages : undefined;
}

function getAnthropicAssistantContent(message: unknown, unaligned?: () => void): AnthropicContentBlock[] | undefined {
	if (!isObject(message) || message.role !== "assistant") return undefined;
	if (Array.isArray(message.content)) {
		const content = message.content.filter(isAnthropicContentBlock);
		if (content.length === message.content.length) return content;
	}
	unaligned?.();
	return undefined;
}

/** A hook can supply array subclasses and accessors. Use only a real array's own data slots for authority. */
function tailData<T>(rows: readonly T[], offset: number): T | undefined {
	return !isProxy(rows) && Array.isArray(rows)
		? Object.getOwnPropertyDescriptor(rows, rows.length - offset)?.value
		: undefined;
}

interface WirePair {
	model: string;
	index: number;
	earlier: object;
	later: object;
	earlierContent: string;
	laterContent: string;
}

/** Temporary receipt shared only by the two ordinary restoration passes around a provider hook. */
export interface ForkReplayHook {
	original?: WirePair;
	matched?: WirePair;
}

function directModel(payload: unknown): unknown {
	// Native Anthropic payloads use an own data field. Do not execute a hook's accessor or proxy trap.
	return isObject(payload) && !isProxy(payload) ? Object.getOwnPropertyDescriptor(payload, "model")?.value : undefined;
}

/**
 * Restore same-model Anthropic replay thinking blocks after provider payload
 * construction and extension payload hooks.
 *
 * Anthropic requires thinking/redacted_thinking blocks from replayed assistant
 * messages to remain byte-for-byte identical to the original response.
 * Extension `before_provider_request` hooks can rewrite them, and older pi-ai
 * converters sanitized thinking text and dropped signed empty thinking.
 * convertToLlm normalizes raw redacted_thinking blocks in its transient,
 * non-mutating LLM-compatible messages before this hook, then this guard
 * restores exact same-model payloads while leaving non-Anthropic and cross-model
 * payloads unchanged.
 */
export function restoreAnthropicReplayThinkingBlocks(
	payload: unknown,
	sourceMessages: readonly Message[],
	model: Model<Api>,
	forkBoundaries?: ForkReplayPair,
	hook?: ForkReplayHook,
): unknown {
	if (model.api !== "anthropic-messages") return payload;

	const payloadMessages = getAnthropicMessages(payload);
	if (!payloadMessages) return payload;

	let allAssistantRowsAligned = true;
	// A string-content assistant is valid but isn't a block-restoration target. Don't infer
	// a final pair from an incomplete list. Ordinary restoration still gets exactly main's rows.
	const unaligned =
		forkBoundaries &&
		(() => {
			allAssistantRowsAligned = false;
		});
	const assistantPayloads = payloadMessages
		.map((message, index) => ({ message, index, content: getAnthropicAssistantContent(message, unaligned) }))
		.filter(
			(entry): entry is { message: JsonObject; index: number; content: AnthropicContentBlock[] } =>
				entry.content !== undefined && isObject(entry.message),
		);

	if (assistantPayloads.length === 0) return payload;

	const emittingSourceAssistants = sourceMessages.filter(
		(message): message is AssistantMessage => message.role === "assistant" && providerEmitsAssistant(message, model),
	);
	// Fail closed when the payload no longer has one assistant per emitting turn, for example
	// because a `before_provider_request` hook added or removed one: ordinal restoration must
	// never splice thinking into a different assistant.
	if (emittingSourceAssistants.length !== assistantPayloads.length) return payload;

	const allowEmptySignature = isObject(model.compat) && (model.compat as JsonObject).allowEmptySignature === true;
	let nextPayloadMessages: unknown[] | undefined;

	// Claude joins adjacent assistants. Only a removed boundary in the latest *emitted* pair
	// can need the fork repair. An aborted reply may not emit at all; a visible user separates them.
	const earlier = forkBoundaries && allAssistantRowsAligned && tailData(assistantPayloads, 2);
	const latest = earlier && tailData(assistantPayloads, 1);
	const source = earlier && tailData(emittingSourceAssistants, 2);
	const laterSource = earlier && tailData(emittingSourceAssistants, 1);
	const sourceBlocks = source && !isProxy(source) && Object.getOwnPropertyDescriptor(source, "content")?.value;
	const sourceLength = sourceBlocks && !isProxy(sourceBlocks) && Array.isArray(sourceBlocks) ? sourceBlocks.length : 0;
	const original = hook?.original;
	const wireModel = earlier && directModel(payload);
	const candidate =
		earlier &&
		source &&
		latest &&
		earlier.index + 1 === latest.index &&
		forkBoundaries.earlier.deref() === source &&
		laterSource &&
		forkBoundaries.later.deref() === laterSource &&
		acceptsForkReplay(model) &&
		sourceLength > 0 &&
		typeof wireModel === "string" &&
		wireModel === (model.fastRoute?.upstreamModelId ?? model.id) &&
		(!original ||
			(original.model === wireModel &&
				original.index === earlier.index &&
				original.earlier === earlier.message &&
				original.later === latest.message))
			? earlier
			: undefined;
	let earlierContent: string | undefined;
	let laterContent: string | undefined;

	for (const [assistantPayloadOrdinal, sourceMessage] of emittingSourceAssistants.entries()) {
		const payloadAssistant = assistantPayloads[assistantPayloadOrdinal];

		if (!isProducedByModel(sourceMessage, model) || !hasReplayThinkingBlock(sourceMessage, allowEmptySignature))
			continue;
		// A second fail-closed guard verifies the non-thinking shape before replacing
		// signed blocks, protecting against equal-count ordinal misalignment.
		if (!nonThinkingBlocksAlign(sourceMessage, payloadAssistant.content)) continue;

		const repairedContent = repairAssistantContent(sourceMessage, payloadAssistant.content, allowEmptySignature);
		const restored = JSON.stringify(repairedContent);
		const received = JSON.stringify(payloadAssistant.content);
		// Inspect the bytes the ordinary guard already read, not hook-controlled getters a second time.
		if (
			candidate &&
			typeof received === "string" &&
			restored === received &&
			(payloadAssistant === earlier || payloadAssistant === latest)
		) {
			// These are the exact bytes main just compared with its source-restored version. An
			// ambiguous/repaired row is not a receipt, and checking the JSON doesn't invoke a getter.
			const blocks: unknown = JSON.parse(received);
			if (!Array.isArray(blocks)) continue;
			if (payloadAssistant === earlier) {
				if (
					(!original || original.earlierContent === received) &&
					blocks.length === sourceLength &&
					blocks.every(isSignedWireBlock)
				)
					earlierContent = received;
			} else if ((!original || original.laterContent === received) && blocks[0] && isSignedWireBlock(blocks[0]))
				laterContent = received;
		}
		if (restored === received) continue;

		nextPayloadMessages ??= [...payloadMessages];
		nextPayloadMessages[payloadAssistant.index] = {
			...payloadAssistant.message,
			content: repairedContent,
		};
	}

	if (
		hook &&
		candidate &&
		latest &&
		typeof wireModel === "string" &&
		earlierContent !== undefined &&
		laterContent !== undefined
	) {
		hook.matched = {
			model: wireModel,
			index: candidate.index,
			earlier: (nextPayloadMessages?.[candidate.index] ?? candidate.message) as object,
			later: (nextPayloadMessages?.[latest.index] ?? latest.message) as object,
			earlierContent,
			laterContent,
		};
	}

	if (!nextPayloadMessages || !isObject(payload)) return payload;
	return { ...payload, messages: nextPayloadMessages };
}
