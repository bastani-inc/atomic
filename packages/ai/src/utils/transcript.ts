import type {
	Context,
	Message,
	SystemMessage,
	TextContent,
	Tool,
	ToolReference,
	TranscriptContext,
	UserMessage,
} from "../types.ts";
import { contentText, getSystemMessageText, renderSystemMessageUpdate } from "./text.ts";

export type { TranscriptContext } from "../types.ts";

/**
 * Build the leading system message for a prompt and tool set. Returns undefined when
 * both are empty, so an empty transcript stays empty.
 */
export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: Tool[] | undefined,
): SystemMessage | undefined {
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return undefined;
	return {
		role: "system",
		content: systemPrompt ?? "",
		...(hasTools ? { toolsAdded: tools } : {}),
		timestamp: 0,
	};
}

/**
 * Fold `Context.systemPrompt` and `Context.tools` into a leading system message.
 * This is the only entry point that produces a {@link TranscriptContext}; every
 * provider-facing function expects the result.
 */
export function normalizeContext(context: Context): TranscriptContext {
	const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
	const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
	return { messages } as TranscriptContext;
}

/**
 * Any message list. The replay helpers only read entries whose role is `"system"`, so
 * agent transcripts that carry custom message roles can be passed without filtering.
 */
export type TranscriptMessages = readonly { role: string }[];

function isSystemMessage(message: { role: string }): message is SystemMessage {
	return message.role === "system";
}

/** Return the leading system message, if the transcript starts with one. */
export function getInitialSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const first = messages[0];
	return first && isSystemMessage(first) ? first : undefined;
}

/** Drop the leading system message for APIs that carry the prompt outside the message list. */
export function withoutInitialSystemMessage(messages: Message[]): Message[] {
	return getInitialSystemMessage(messages) ? messages.slice(1) : messages;
}

/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** Render the current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : "";
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages: the replayed
 * system message leads, and every later system message is dropped.
 */
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
	const head = getCurrentSystemMessage(context.messages);
	const messages = context.messages.filter((message) => message.role !== "system");
	return { messages: head ? [head, ...messages] : messages } as TranscriptContext;
}

/** Keep later system messages in place when the model accepts them; otherwise collapse them. */
export function resolveTranscript(
	context: TranscriptContext,
	supportsMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
	return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}

/**
 * Rebuild the transcript for APIs without mid-conversation system messages without changing the
 * prompt earlier requests sent, so a prompt change after the first reply extends the cached prefix
 * instead of rewriting it.
 *
 * The system messages that open the conversation, from the first one up to the next message, fold
 * into the leading message, exactly as {@link collapseSystemMessages} folds them, and the leading
 * message holds the current tools. The first request sends them all, so nothing is rewritten.
 *
 * Each later system message's {@link renderSystemMessageUpdate} text is sent as text blocks at its
 * place in the transcript, after any tool results that follow it, so that user and assistant turns
 * still alternate: added after the blocks of the user message before it; after tool results, as a
 * user message of its own marked by {@link followsToolResults}, which user input that follows joins;
 * or else put before the blocks of the user message after it, or else, between two assistant messages
 * or after the last one, as a user message of its own. An update never goes inside a tool result.
 * Blocks are only ever added after what an earlier request sent, so its cached prefix stays the same.
 */
export function appendSystemMessageUpdates(context: TranscriptContext): TranscriptContext {
	const messages = context.messages;
	const firstSystem = messages.findIndex(isSystemMessage);
	const firstInput =
		firstSystem === -1 ? -1 : messages.findIndex((message, index) => index > firstSystem && message.role !== "system");
	const cut = firstInput === -1 ? messages.length : firstInput;
	const folded = getCurrentSystemMessage(messages.slice(0, cut));
	const tools = getCurrentTools(messages);
	const result: Message[] = [];
	if (folded || tools.length > 0) {
		const { toolsAdded: _toolsAdded, ...prompt } = folded ?? { role: "system" as const, content: "", timestamp: 0 };
		result.push({ ...prompt, ...(tools.length > 0 ? { toolsAdded: tools } : {}) });
	}
	let updates: { texts: TextContent[]; timestamp: number } | undefined;
	/** Replaces the last message with `message`, which keeps its place after tool results. */
	const replaceLast = (message: UserMessage): void => {
		if (afterToolResults.has(result[result.length - 1]!)) afterToolResults.add(message);
		result[result.length - 1] = message;
	};
	/** Places the pending updates before `next`, the message about to be added, or at the end; returns `next` to add. */
	const placeUpdates = (next: Message | undefined): Message | undefined => {
		if (!updates) return next;
		const { texts, timestamp } = updates;
		updates = undefined;
		// Appended blocks only ever follow blocks an earlier request already sent, so the cached block prefix stays
		// intact; a leading block goes into a message no request has sent yet.
		const last = result.at(-1);
		if (last?.role === "user") {
			replaceLast({ ...last, content: [...asBlocks(last.content), ...texts] });
			return next;
		}
		// Never inside a tool result, where the model would read it as tool output.
		if (last?.role === "toolResult") {
			const update: UserMessage = { role: "user", content: texts, timestamp };
			afterToolResults.add(update);
			result.push(update);
			return next;
		}
		if (next?.role === "user") return { ...next, content: [...texts, ...asBlocks(next.content)] };
		result.push({ role: "user", content: texts, timestamp });
		return next;
	};
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "system") {
			if (index < cut) continue;
			const text = renderSystemMessageUpdate(message);
			if (text.length === 0) continue;
			updates ??= { texts: [], timestamp: message.timestamp };
			updates.texts.push({ type: "text", text });
			continue;
		}
		// A tool call's results must directly follow it, so an update waits until after them.
		if (message.role === "toolResult") {
			result.push(message);
			continue;
		}
		const placed = placeUpdates(message)!;
		const last = result.at(-1);
		// User input after an update that follows tool results joins it, so user messages never sit side by side.
		if (placed.role === "user" && last?.role === "user" && afterToolResults.has(last)) {
			replaceLast({
				...last,
				content: [...asBlocks(last.content), ...asBlocks(placed.content)],
				...(placed.cacheBreakpoint ? { cacheBreakpoint: true } : {}),
			});
			continue;
		}
		result.push(placed);
	}
	placeUpdates(undefined);
	return { messages: result } as TranscriptContext;
}

/** User messages of prompt updates that {@link appendSystemMessageUpdates} placed directly after tool results. */
const afterToolResults = new WeakSet<Message>();

/**
 * Whether `message` is a user message of prompt updates, possibly followed by user input, that
 * {@link appendSystemMessageUpdates} placed directly after tool results. Providers whose tool results are user content
 * send its blocks after the tool results in the same user message, so user turns never sit side by side; others send
 * it as the user message after the tool messages.
 */
export function followsToolResults(message: Message): boolean {
	return afterToolResults.has(message);
}

function asBlocks(content: UserMessage["content"]): Exclude<UserMessage["content"], string> {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Keep later system messages in place when the model accepts them; otherwise append each prompt
 * change after the history earlier requests sent ({@link appendSystemMessageUpdates}).
 */
export function resolveRequestTranscript(
	context: TranscriptContext,
	supportsMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
	return supportsMidConvoSystemMessages ? context : appendSystemMessageUpdates(context);
}

/** Strip executable and display-only fields from a tool before transcript comparison or persistence. */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

/** `value` serialized with every object's keys in code point order; array order is kept. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value !== "object" || value === null) return JSON.stringify(value);
	const entries = Object.entries(value)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * Whether two tools declare the same interface to the model.
 *
 * Both sides go through {@link toToolDeclaration} first: its JSON round-trip drops the
 * schema metadata keys (TypeBox's non-enumerable kind marks) and `undefined` fields that a structural comparison would see.
 * Object keys are compared in a canonical order, so a schema rebuilt with its keys in another order, as a server may
 * send it after reconnecting, is not a new definition. Array order counts. This avoids a deep-equal dependency in a
 * browser-safe package.
 */
export function declarationsEqual(left: Tool, right: Tool): boolean {
	const leftDeclaration = toToolDeclaration(left);
	const rightDeclaration = toToolDeclaration(right);
	return (
		JSON.stringify(leftDeclaration) === JSON.stringify(rightDeclaration) ||
		canonicalJson(leftDeclaration) === canonicalJson(rightDeclaration)
	);
}

export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: ToolReference[];
}

/** Compare two complete tool states. A changed definition is a removal followed by an addition. */
export function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges {
	const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
	const currentTools = new Map(current.map((tool) => [tool.name, tool]));
	return {
		toolsAdded: current
			.filter((tool) => {
				const previousTool = previousTools.get(tool.name);
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			.map(toToolDeclaration),
		toolsRemoved: previous
			.filter((tool) => {
				const currentTool = currentTools.get(tool.name);
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			.map((tool) => ({ name: tool.name })),
	};
}

/** Every definition referenced by transcript tool state, in first-declaration order. */
export function getDeclaredTools(messages: TranscriptMessages): Tool[] {
	const definitions = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) definitions.set(tool.name, tool);
	}
	return [...definitions.values()];
}

/**
 * Whether a tool name was declared twice with different definitions. A transport that can
 * only reference previously declared tools by name cannot replay such a history.
 *
 * @deprecated No built-in transport needs this anymore: Anthropic expresses redefinitions with
 * inline `tool_definition` blocks. Kept for API compatibility and will be removed in a future release.
 */
export function hasToolRedefinitions(messages: TranscriptMessages): boolean {
	const declared = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) {
			const previous = declared.get(tool.name);
			if (previous !== undefined && !declarationsEqual(previous, tool)) return true;
			declared.set(tool.name, tool);
		}
	}
	return false;
}

/** Whether tool history contains a removal or same-name redeclaration that an addition-only transport cannot replay. */
export function hasNonAdditiveToolChanges(messages: TranscriptMessages): boolean {
	return findLastNonAdditiveToolChange(messages.filter(isSystemMessage)) >= 0;
}

/** Index of the last system message with a removal or same-name redeclaration, or -1. */
function findLastNonAdditiveToolChange(systemMessages: readonly SystemMessage[]): number {
	// A name declared before counts as a redeclaration even after its removal: Kimi K3 ignores a
	// removed tool that a later tool message declares again (verified October 2026).
	const declared = new Set<string>();
	let last = -1;
	for (let index = 0; index < systemMessages.length; index++) {
		const message = systemMessages[index];
		if ((message.toolsRemoved?.length ?? 0) > 0) last = index;
		for (const tool of message.toolsAdded ?? []) {
			if (declared.has(tool.name)) last = index;
			declared.add(tool.name);
		}
	}
	return last;
}

/**
 * How a transport can express tool changes after the first request.
 *
 * - `"none"`: only the top-level tool list exists; it always holds the current tools.
 * - `"additions"`: tools can be added at a later message, but not removed or redefined.
 * - `"changes"`: every tool, including the initial ones, is declared in place, and a later
 *   declaration under the same name replaces the earlier one. Removals are not expressible on
 *   the wire, so the transport announces them as text and the removed tools stay declared.
 */
export type TranscriptToolSupport = "none" | "additions" | "changes";

export interface TranscriptTools {
	/** Tools sent in the top-level request field. */
	requestTools: Tool[];
	/**
	 * Number of leading system messages whose tool changes `requestTools` already holds. Every
	 * later system message carries its own tool changes in place.
	 */
	foldedSystemMessages: number;
}

/**
 * Split tool declarations between the top-level request field and in-place changes.
 *
 * With `"changes"`, the top-level list stays empty and every system message, including the
 * leading one, declares its tools in place: an in-place declaration can replace an earlier
 * in-place one, but not a top-level one. With `"additions"`, a removal or redefinition cannot be
 * expressed in place, so the top-level list becomes the tool state after the last such change;
 * later additions stay anchored, and the cached prefix is invalidated once per removal instead
 * of on every later addition. With `"none"`, the top-level list is the current tool set.
 */
export function resolveTranscriptTools(messages: TranscriptMessages, support: TranscriptToolSupport): TranscriptTools {
	const systemMessages = messages.filter(isSystemMessage);
	if (support === "none") {
		return { requestTools: getCurrentTools(systemMessages), foldedSystemMessages: systemMessages.length };
	}
	if (support === "changes") return { requestTools: [], foldedSystemMessages: 0 };
	const folded = Math.max(
		getInitialSystemMessage(messages) ? 1 : 0,
		findLastNonAdditiveToolChange(systemMessages) + 1,
	);
	return { requestTools: getCurrentTools(systemMessages.slice(0, folded)), foldedSystemMessages: folded };
}
