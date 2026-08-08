/**
 * Session summarization for the resume picker.
 *
 * Produces one short line describing what a session was about, so `/resume` can show
 * something recognizable instead of a truncated first message. Unlike a branch summary this
 * never re-enters model context: it exists only as picker metadata.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type ProviderHeaders, type RetryPolicy, retryAssistantCall, uuidv7 } from "@earendil-works/pi-ai";
import type { Api, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";
import type { SessionEntry } from "../session-manager.ts";
import { prepareBranchEntries } from "./branch-summarization.ts";
import { SUMMARIZATION_SYSTEM_PROMPT, serializeConversation } from "./utils.ts";

// ============================================================================
// Types
// ============================================================================

export interface SessionSummaryResult {
	summary?: string;
	usage?: Usage;
	aborted?: boolean;
	error?: string;
}

export interface GenerateSessionSummaryOptions {
	/** Model to use for summarization */
	model: Model<Api>;
	/** API key for the model; omitted for header-only bearer authentication. */
	apiKey?: string;
	/** Request headers for the model */
	headers?: ProviderHeaders;
	/** Credential-specific request endpoint for the model */
	baseUrl?: string;
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Optional session stream function. Used to preserve SDK request behavior without mutating agent state. */
	streamFn?: StreamFn;
	/** Retry policy for transient failures. Retries stay silent: this is background work. */
	retry?: RetryPolicy;
}

// ============================================================================
// Generation
// ============================================================================

/**
 * Recent conversation fed to the summarizer. A one-line summary does not improve with more
 * history, and this runs after every idle turn, so the input stays deliberately small.
 */
const SESSION_SUMMARY_INPUT_TOKENS = 4000;

/** Hard ceiling on the stored line. The picker truncates to width; this bounds what we persist. */
const SESSION_SUMMARY_MAX_CHARS = 160;

const SESSION_SUMMARY_PROMPT = `Describe this coding session in one short sentence, at most 120 characters, so someone scanning a list of sessions can tell what it was about.

Name the concrete task and the main file, feature, or component involved. Write plain text: no markdown, no quotes, no line breaks, and do not refer to the session or the summary itself.`;

/** Collapse a model response into the single line the picker can render. */
function toSingleLine(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > SESSION_SUMMARY_MAX_CHARS
		? `${collapsed.slice(0, SESSION_SUMMARY_MAX_CHARS - 1).trimEnd()}…`
		: collapsed;
}

/**
 * Generate a one-line summary of a session.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateSessionSummary(
	entries: SessionEntry[],
	options: GenerateSessionSummaryOptions,
): Promise<SessionSummaryResult> {
	const { model, apiKey, headers, baseUrl, signal, streamFn, retry } = options;

	const { messages } = prepareBranchEntries(entries, SESSION_SUMMARY_INPUT_TOKENS);
	if (messages.length === 0) {
		return {};
	}

	// Transform to LLM-compatible messages, then serialize to text.
	// Serialization prevents the model from treating it as a conversation to continue.
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${SESSION_SUMMARY_PROMPT}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// Call LLM for summarization. Prefer the session stream function so SDK
	// request behavior stays consistent without mutating agent state.
	const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
	const requestModel = baseUrl === undefined || baseUrl === model.baseUrl ? model : { ...model, baseUrl };
	// No reasoning is requested. One sentence gains nothing from thinking tokens, and this
	// request runs after every idle turn.
	const requestOptions: SimpleStreamOptions = {
		apiKey,
		headers,
		signal,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};
	const response = await (async () => {
		try {
			return await retryAssistantCall(
				async () =>
					streamFn
						? (await streamFn(requestModel, context, requestOptions)).result()
						: completeSimple(requestModel, context, requestOptions),
				retry,
				signal,
			);
		} catch (error) {
			if (signal.aborted) return undefined;
			return {
				stopReason: "error" as const,
				errorMessage: error instanceof Error ? error.message : String(error),
			};
		}
	})();

	if (!response || response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Session summarization failed" };
	}

	const summary = toSingleLine(
		response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" "),
	);

	return summary ? { summary, usage: response.usage } : { usage: response.usage };
}
