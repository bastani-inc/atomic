import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const NON_DOCUMENT_USER_PLACEHOLDER = "(document omitted: model does not support document input)";

/**
 * Whether the target model's API adjudicates thinking-block model binding itself.
 *
 * Anthropic's preserved-thinking rules make the API, not the client, the authority on which
 * thinking blocks a model may read: "Pass blocks back unchanged. Send every assistant turn
 * exactly as you received it, thinking blocks included, and let the API decide which blocks the
 * model can use", and "A block that fails the model check is always dropped" before the prompt
 * reaches the model, unbilled.
 * https://platform.claude.com/docs/en/build-with-claude/thinking#preserved-thinking
 *
 * Flattening those blocks into visible text client-side is both lossy (a newer model that is
 * allowed to read them loses the reasoning) and destabilizing (it rewrites the conversation
 * prefix that later thinking-block signatures are bound to). Models whose generated metadata
 * sets this flag replay foreign signed blocks unchanged instead.
 */
function delegatesThinkingModelBinding<TApi extends Api>(model: Model<TApi>): boolean {
	if (model.api !== "anthropic-messages") return false;
	const compat = model.compat as AnthropicMessagesCompat | undefined;
	return compat?.delegatesThinkingModelBinding === true;
}

// Preserves the caller's block union minus images, so a user message keeps its document blocks
// while a tool result — which cannot carry one — keeps its narrower type.
function replaceImagesWithPlaceholder<TBlock extends { type: string }>(
	content: TBlock[],
	placeholder: string,
): (Exclude<TBlock, ImageContent> | TextContent)[] {
	const result: (Exclude<TBlock, ImageContent> | TextContent)[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		const kept = block as Exclude<TBlock, ImageContent>;
		result.push(kept);
		previousWasPlaceholder = kept.type === "text" && (kept as unknown as TextContent).text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg): Message => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Replace document blocks with a visible placeholder for models that cannot receive one.
 *
 * Mirrors the image downgrade: only the Anthropic Messages and Amazon Bedrock Converse paths can
 * serialize a document, so every other provider — and any Claude mirror whose generated `input`
 * omits `"pdf"` — gets a marker rather than a silently missing attachment or a rejected request.
 * Documents only ever appear in user messages; tool results stay text/image-only.
 */
function downgradeUnsupportedDocuments<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("pdf")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
		if (!msg.content.some((block) => block.type === "document")) return msg;

		const content: (TextContent | ImageContent)[] = [];
		let previousWasPlaceholder = false;
		for (const block of msg.content) {
			if (block.type === "document") {
				if (!previousWasPlaceholder) content.push({ type: "text", text: NON_DOCUMENT_USER_PLACEHOLDER });
				previousWasPlaceholder = true;
				continue;
			}
			content.push(block);
			previousWasPlaceholder = block.type === "text" && block.text === NON_DOCUMENT_USER_PLACEHOLDER;
		}
		return { ...msg, content };
	});
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Tool calls dropped for preceding a fallback boundary. Their results must go too: a
	// `tool_result` whose `tool_use` is absent is rejected, and `ToolResultMessage` is a separate
	// top-level message so removing the call alone would orphan it.
	const droppedToolCallIds = new Set<string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedDocuments(
		downgradeUnsupportedImages(normalizedMessages, model),
		model,
	);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed = imageAwareMessages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;
			// A different model on the same provider and API whose API adjudicates model binding
			// itself. Its signed blocks replay unchanged; the API keeps the ones the target model
			// may read and silently drops the rest.
			const canReplayForeignThinking =
				!isSameModel &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				delegatesThinkingModelBinding(model);
			const preservesThinking = isSameModel || canReplayForeignThinking;

			// After a mid-output server-side fallback the turn holds output from two models either
			// side of a `fallback` marker. Anthropic's replay rules: keep the marker "exactly where
			// it appeared", keep `text` and everything after it, and drop `thinking`,
			// `redacted_thinking`, and client-side `tool_use` that precede the final marker. A
			// request that echoes thinking from both sides is rejected outright, so this is a
			// correctness requirement rather than a token saving — and it applies even when the
			// blocks would otherwise be replayable.
			// https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
			// `findLastIndex` needs ES2023; this package targets ES2022.
			let finalFallbackIndex = -1;
			for (let i = assistantMsg.content.length - 1; i >= 0; i--) {
				if (assistantMsg.content[i].type === "fallback") {
					finalFallbackIndex = i;
					break;
				}
			}

			const transformedContent = assistantMsg.content.flatMap((block, blockIndex) => {
				const precedesFallbackBoundary = finalFallbackIndex >= 0 && blockIndex < finalFallbackIndex;

				if (block.type === "fallback") {
					// Only the final marker is load-bearing for validation, but earlier ones are
					// equally "where they appeared", so every marker is preserved in place.
					return block;
				}

				if (block.type === "thinking") {
					if (precedesFallbackBoundary) return [];
					// Redacted thinking is opaque encrypted content the client cannot rewrite.
					// Replay it where the API adjudicates it; otherwise drop it to avoid API errors.
					if (block.redacted) {
						return preservesThinking ? block : [];
					}
					// Keep signed thinking blocks for replay even when the thinking text is empty
					// (OpenAI encrypted reasoning, or Anthropic `display: "omitted"`).
					if (preservesThinking && block.thinkingSignature) return block;
					// Skip empty thinking blocks, convert others to plain text
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (preservesThinking) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					// Client-side `tool_use` before the final fallback marker must be dropped: the
					// declining model's tool call was never executed by the model that continued.
					// Record the id so its `toolResult` message is dropped alongside it.
					if (precedesFallbackBoundary) {
						droppedToolCallIds.add(block.id);
						return [];
					}
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Drop the tool results whose calls were removed at a fallback boundary. Anthropic rejects a
	// `tool_result` with no matching `tool_use`, so removing the call without its result would
	// trade one rejection for another.
	const boundaryFiltered =
		droppedToolCallIds.size === 0
			? transformed
			: transformed.filter((msg) => msg.role !== "toolResult" || !droppedToolCallIds.has(msg.toolCallId));

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (let i = 0; i < boundaryFiltered.length; i++) {
		const msg = boundaryFiltered[i];

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			insertSyntheticToolResults();

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// User message interrupts tool flow - insert synthetic results for orphaned calls
			insertSyntheticToolResults();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	insertSyntheticToolResults();

	return result;
}
