import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getEffectiveInputBudget } from "./context-window.ts";
import { estimateContextTokens, shouldCompact, type VerbatimCompactionResult } from "./compaction/index.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { scrubPreCompactionAssistantUsage } from "./provider-context-usage.ts";

function postToolFailureMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `Post-tool context compaction failed before the next provider request: ${detail}`;
}

function hardLimitMessage(projectedTokens: number, hardInputLimit: number): string {
	return `Post-tool context remains over the provider hard input limit after compaction (${projectedTokens} > ${hardInputLimit} tokens); the next provider request was not sent.`;
}

/** Compact tool-expanded context without scheduling a second Agent continuation. */
export async function _preflightPostToolContext(
	this: AgentSession,
	messages: AgentMessage[],
	signal?: AbortSignal,
): Promise<AgentMessage[]> {
	const model = this.model;
	const settings = this.settingsManager.getCompactionSettings();
	if (!model || !settings.enabled) return messages;

	const hardInputLimit = getEffectiveInputBudget(model);
	if (!shouldCompact(estimateContextTokens(messages).tokens, hardInputLimit, settings)) return messages;

	// Tool-result persistence is ordered on AgentSession's event queue, while Pi
	// may reach its next-turn hook as soon as its own listener barrier settles.
	await this._agentEventQueue;
	if (this._autoCompactionAbortController) {
		const message = postToolFailureMessage("another automatic compaction is already active");
		this._postToolCompactionPreflightError = message;
		throw new Error(message);
	}

	const abortController = new AbortController();
	const relayAbort = () => abortController.abort();
	signal?.addEventListener("abort", relayAbort, { once: true });
	if (signal?.aborted) abortController.abort();
	this._autoCompactionAbortController = abortController;
	this._emit({ type: "compaction_start", reason: "threshold", midTurn: true });

	try {
		const result = await this._applyVerbatimCompaction({
			resolvePlannerAuth: async () => {
				const auth = await this._modelRegistry.getApiKeyAndHeaders(model);
				return auth.ok && auth.apiKey
					? { apiKey: auth.apiKey, headers: auth.headers, baseUrl: auth.baseUrl }
					: undefined;
			},
			abortController,
			backupLabel: "auto-compact",
			reason: "threshold",
		});
		if (!result) throw new Error("no compactable transcript entries were available");

		this._pendingPostToolCompactionGuard = { hardInputLimit, result };
		return this.agent.state.messages;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const aborted =
			abortController.signal.aborted ||
			detail === "Compaction cancelled" ||
			(error instanceof Error && error.name === "AbortError");
		const errorMessage = aborted
			? "Post-tool context compaction was cancelled before the next provider request."
			: postToolFailureMessage(error);
		this._postToolCompactionPreflightError = errorMessage;
		this._emit({
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted,
			willRetry: false,
			midTurn: true,
			...(aborted ? {} : { errorMessage }),
		});
		throw new Error(errorMessage, { cause: error });
	} finally {
		signal?.removeEventListener("abort", relayAbort);
		this._autoCompactionAbortController = undefined;
	}
}

/** Gate the transformed message context immediately before provider conversion. */
export function _finishPostToolCompactionPreflight(
	this: AgentSession,
	messages: AgentMessage[],
): AgentMessage[] {
	const pending = this._pendingPostToolCompactionGuard;
	if (!pending) return messages;
	this._pendingPostToolCompactionGuard = undefined;

	const providerBoundMessages = scrubPreCompactionAssistantUsage(messages, this.sessionManager.getBranch());
	const projectedTokens = estimateContextTokens(providerBoundMessages).tokens;
	if (projectedTokens > pending.hardInputLimit) {
		const errorMessage = hardLimitMessage(projectedTokens, pending.hardInputLimit);
		this._postToolCompactionPreflightError = errorMessage;
		this._emit({
			type: "compaction_end",
			reason: "threshold",
			result: pending.result,
			aborted: false,
			willRetry: false,
			midTurn: true,
			errorMessage,
		});
		throw new Error(errorMessage);
	}

	this._emit({
		type: "compaction_end",
		reason: "threshold",
		result: pending.result,
		aborted: false,
		willRetry: false,
		midTurn: true,
	});
	return providerBoundMessages;
}

export interface PendingPostToolCompactionGuard {
	hardInputLimit: number;
	result: VerbatimCompactionResult;
}

export const agentSessionPostToolCompactionMethods = {
	_preflightPostToolContext,
	_finishPostToolCompactionPreflight,
};
