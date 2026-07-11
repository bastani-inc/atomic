/**
 * Neutral context-usage metrics for deciding when a session needs compaction.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "../session-manager.ts";
import { messageIsLlmVisible, userLikeContentBlockIsLlmVisible } from "../messages.ts";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	/** Fraction of compactable context to keep. 0.3 is aggressive, 0.7 is light. */
	compression_ratio: number;
	/** Number of recent context-eligible messages to preserve in standard mode. */
	preserve_recent: number;
	/** Focus query for relevance-based pruning; auto-detected when omitted in settings/options. */
	query?: string;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	compression_ratio: 0.5,
	preserve_recent: 2,
};

/**
 * Calculate active context-window tokens from provider usage.
 *
 * Prefer normalized component fields over `totalTokens`: some providers expose
 * `totalTokens` as a billing/cumulative total, while the footer needs an active
 * context estimate. Anthropic-compatible endpoints can also mirror cached input
 * in both `input` and `cacheRead`/`cacheWrite`; when cache buckets are nearly the
 * same size as `input`, treat `input` as the full prompt instead of counting the
 * same cached prompt twice.
 */
export function calculateContextTokens(usage: Usage): number {
	const input = Math.max(0, usage.input || 0);
	const output = Math.max(0, usage.output || 0);
	const cacheRead = Math.max(0, usage.cacheRead || 0);
	const cacheWrite = Math.max(0, usage.cacheWrite || 0);
	const cacheTokens = cacheRead + cacheWrite;
	const hasComponents = input > 0 || output > 0 || cacheTokens > 0;
	if (!hasComponents) return Math.max(0, usage.totalTokens || 0);

	const cacheMirrorsInput = input > 0 && cacheTokens > 0 && cacheTokens >= input * 0.9 && cacheTokens <= input * 1.1;
	const promptTokens = cacheMirrorsInput ? input : input + cacheTokens;
	return promptTokens + output;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const usage = getAssistantUsage(message);
		if (usage && message.timestamp >= latestPrefixTimestamp && calculateContextTokens(usage) > 0) {
			usageInfo = { usage, index: i };
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

/**
 * Shared image-token estimation used by every compaction/context-accounting path.
 *
 * Providers fold image tokens into their reported prompt/input usage, so usage-based
 * accounting already captures actual image cost. For heuristic paths (trailing
 * messages without usage, transcript content-block estimates) a single conservative
 * fixed estimate keeps both the context-window threshold check and the transcript
 * planner consistent.
 */
export const ESTIMATED_IMAGE_CHARS = 4800;
export const ESTIMATED_IMAGE_TOKENS = Math.ceil(ESTIMATED_IMAGE_CHARS / 4);

function safeSerializedPayloadLength(value: unknown, fallback: string): number {
	try {
		const serialized = JSON.stringify(value);
		if (typeof serialized === "string") return serialized.length;
	} catch {
		// Cyclic and otherwise unserializable future blocks use a conservative marker below.
	}
	return fallback.length;
}

function nonEmptyBlockType(block: unknown): string | undefined {
	if (!block || typeof block !== "object") return undefined;
	const type = (block as { type?: unknown }).type;
	return typeof type === "string" && type.trim().length > 0 ? type : undefined;
}

function estimateContentBlockChars(block: unknown): number {
	const type = nonEmptyBlockType(block);
	if (!type) return 0;
	const record = block as Record<string, unknown>;
	if (type === "image") return ESTIMATED_IMAGE_CHARS;
	if (type === "text") return typeof record.text === "string" ? record.text.length : 0;
	if (type === "thinking") return typeof record.thinking === "string" ? record.thinking.length : 0;
	if (type === "toolCall") {
		const nameLength = typeof record.name === "string" ? record.name.length : 0;
		return nameLength + safeSerializedPayloadLength(record.arguments, "[unserializable tool arguments]");
	}
	return safeSerializedPayloadLength(block, `[unserializable ${type} block]`);
}

/** Estimate one raw content block after the caller applies provider visibility. */
export function estimateContentBlockTokens(block: unknown, visible = true): number {
	if (!visible) return 0;
	const chars = estimateContentBlockChars(block);
	return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function estimateUserLikeContentTokens(content: unknown): number {
	if (typeof content === "string") return content.trim().length > 0 ? Math.ceil(content.length / 4) : 0;
	if (!Array.isArray(content)) return 0;
	const chars = content.reduce(
		(total, block) => total + (userLikeContentBlockIsLlmVisible(block) ? estimateContentBlockChars(block) : 0),
		0,
	);
	return chars > 0 ? Math.ceil(chars / 4) : 0;
}

/**
 * Count image content blocks in a message content array (text or block array).
 *
 * Exported as the canonical image-counting contract so tests can verify the
 * heuristic independently of the transcript-based estimation used in production.
 */
export function countImageContentBlocks(content: string | Array<{ type: string }>): number {
	if (typeof content === "string" || !Array.isArray(content)) return 0;
	let count = 0;
	for (const block of content) {
		if (block && typeof block === "object" && block.type === "image") count += 1;
	}
	return count;
}

/**
 * Estimate the token cost of only the image content blocks in a message content array.
 *
 * Exported as the canonical image-token-estimation contract so tests can verify
 * the heuristic independently of the transcript-based estimation used in production.
 */
export function estimateImageContentTokens(content: string | Array<{ type: string }>): number {
	return countImageContentBlocks(content) * ESTIMATED_IMAGE_TOKENS;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	if (!message || typeof message !== "object" || !messageIsLlmVisible(message)) return 0;

	switch (message.role) {
		case "user":
		case "custom":
			return estimateUserLikeContentTokens((message as { content?: unknown }).content);
		case "assistant": {
			const content = (message as { content?: unknown }).content;
			if (!Array.isArray(content)) return 0;
			const chars = content.reduce((total, block) => total + estimateContentBlockChars(block), 0);
			return chars > 0 ? Math.ceil(chars / 4) : 0;
		}
		case "toolResult": {
			const content = (message as { content?: unknown }).content;
			if (!Array.isArray(content)) return 0;
			const chars = content.reduce((total, block) => total + estimateContentBlockChars(block), 0);
			return chars > 0 ? Math.ceil(chars / 4) : 0;
		}
		case "bashExecution": {
			const command = typeof message.command === "string" ? message.command : "";
			const output = typeof message.output === "string" ? message.output : "";
			return Math.ceil((command.length + output.length) / 4);
		}
		case "branchSummary":
			return typeof message.summary === "string" ? Math.ceil(message.summary.length / 4) : 0;
	}

	return 0;
}
