/**
 * Neutral context-usage metrics for deciding when a session needs compaction.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "../session-manager.ts";

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
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
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

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Count image content blocks in a message content array (text or block array).
 *
 * Exported as the canonical image-counting contract so tests can verify the
 * heuristic independently of the transcript-based estimation used in production.
 */
export function countImageContentBlocks(content: string | Array<{ type: string }>): number {
	if (typeof content === "string") return 0;
	let count = 0;
	for (const block of content) {
		if (block.type === "image") count += 1;
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
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}
