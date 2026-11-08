import type { Api, Model } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import type { NumberedRegion, VerbatimCompactionPreparation } from "../src/core/compaction/compaction-types.js";
import { createConversationRegion } from "../src/core/compaction/transcript-serialization.js";
import type { FauxResponse } from "./test-harness.js";

export const plannerModel: Model<Api> = {
	id: "primary",
	name: "Primary",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

export const fallbackModel: Model<Api> = { ...plannerModel, id: "fallback" };

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageText(label: string, lineCount: number): string {
	return Array.from({ length: lineCount }, (_, line) => `${label} line ${line + 1}`).join("\n");
}

/** Alternating user and assistant messages of `linesPerMessage` text lines each, one blank line apart. */
export function conversation(messageCount: number, linesPerMessage = 3): AgentMessage[] {
	return Array.from({ length: messageCount }, (_, index): AgentMessage => {
		const text = messageText(`message ${index + 1}`, linesPerMessage);
		if (index % 2 === 0) return { role: "user", content: [{ type: "text", text }], timestamp: index };
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: "test",
			model: "primary",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: index,
		};
	});
}

/** A region of `messageCount` messages; each holds `linesPerMessage + 1` lines except the last. */
export function conversationRegion(messageCount: number, linesPerMessage = 3): NumberedRegion {
	return createConversationRegion(conversation(messageCount, linesPerMessage));
}

export function preparationFor(region: NumberedRegion, compressionRatio = 0.5): VerbatimCompactionPreparation {
	return {
		firstKeptEntryId: "tail",
		region,
		regionEntryIds: ["old"],
		keptTailMessageCount: 0,
		tokensBefore: region.tokenEstimate,
		parameters: { compression_ratio: compressionRatio, preserve_recent: 0, query: "continue" },
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

/** The refusal a provider's output classifier sends after the model has already generated tokens. */
export const REFUSED_MIDSTREAM: FauxResponse = {
	stopReason: "error",
	error: "The model refused to complete the request",
	usage: { output: 25_000, reasoning: 20_000 },
};

/** The refusal a provider's input classifier sends at once, before any token is generated. */
export const REFUSED_BEFORE_OUTPUT: FauxResponse = {
	stopReason: "error",
	error: "The model refused to complete the request",
	usage: { output: 0 },
};
