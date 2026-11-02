import type { BetaContentBlockParam as ContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { AnthropicMessagesCompat, Api, AssistantMessage, Model } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { transformMessages } from "./transform-messages.ts";

export interface AnthropicAssistantContentOptions {
	/** Send unsigned thinking as `thinking` with an empty signature, as some compatible providers expect. */
	allowEmptySignature: boolean;
	/** The tool name sent on the wire, for example the Claude Code name under OAuth. */
	toolName?: (name: string) => string;
}

/**
 * Convert an assistant turn already prepared by `transformMessages` into the content blocks an
 * Anthropic Messages request carries for it. An empty result means the request omits the turn.
 */
export function convertAnthropicAssistantContent(
	message: AssistantMessage,
	options: AnthropicAssistantContentOptions,
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];

	for (const block of message.content) {
		if (block.type === "text") {
			if (block.text.trim().length === 0) continue;
			blocks.push({
				type: "text",
				text: sanitizeSurrogates(block.text),
			});
		} else if (block.type === "thinking") {
			// Redacted thinking: pass the opaque payload back as redacted_thinking
			if (block.redacted) {
				blocks.push({
					type: "redacted_thinking",
					data: block.thinkingSignature!,
				});
				continue;
			}
			const thinkingSignature = block.thinkingSignature;
			const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
			if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
			// If thinking signature is missing/empty (e.g., from aborted stream),
			// convert to plain text for Anthropic. Some compatible providers emit
			// and accept empty signatures, so let marked models preserve the block.
			if (!hasThinkingSignature) {
				blocks.push(
					options.allowEmptySignature
						? {
								type: "thinking",
								thinking: sanitizeSurrogates(block.thinking),
								signature: "",
							}
						: {
								type: "text",
								text: sanitizeSurrogates(block.thinking),
							},
				);
			} else {
				// The signature covers these exact bytes, and Anthropic rejects a latest assistant
				// message whose signed thinking differs from what it returned, so no sanitizing here.
				blocks.push({
					type: "thinking",
					thinking: block.thinking,
					signature: thinkingSignature,
				});
			}
		} else if (block.type === "toolCall") {
			blocks.push({
				type: "tool_use",
				id: block.id,
				name: options.toolName ? options.toolName(block.name) : block.name,
				input: block.arguments ?? {},
			});
		} else if (block.type === "fallback") {
			// The server-side fallback boundary must go back on the wire at the position it
			// arrived: "Keep it exactly where it appeared. The API uses its position to
			// validate the thinking blocks around it, so a request that echoes thinking
			// blocks from both sides of the boundary is rejected if the block is omitted or
			// moved." `transformMessages` drops the pre-boundary thinking; without this
			// branch the marker would be dropped too, which is the failure that rule names.
			// https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
			//
			// The SDK types lag this block, matching the cast on the stream side.
			blocks.push({
				type: "fallback",
				from: { model: block.fromModel },
				to: { model: block.toModel },
			} as unknown as ContentBlockParam);
		}
	}

	return blocks;
}

/**
 * The content blocks that an Anthropic Messages request for `model` carries for one transcript
 * turn, produced by the same `transformMessages` pass and block conversion as the request itself.
 *
 * Empty when the request omits the turn: an errored or aborted turn, or one with nothing left to
 * send, such as a turn that held only another model's reasoning. A turn that keeps a server-side
 * `fallback` marker always has content, because the marker is replayed even when every other block
 * is dropped. Tool call IDs and names are the transcript's, not their normalized or OAuth wire forms.
 */
export function anthropicAssistantReplayContent(message: AssistantMessage, model: Model<Api>): ContentBlockParam[] {
	const transformed = transformMessages([message], model).find(
		(candidate): candidate is AssistantMessage => candidate.role === "assistant",
	);
	if (!transformed) return [];
	const compat =
		model.api === "anthropic-messages" ? (model.compat as AnthropicMessagesCompat | undefined) : undefined;
	return convertAnthropicAssistantContent(transformed, { allowEmptySignature: compat?.allowEmptySignature === true });
}
