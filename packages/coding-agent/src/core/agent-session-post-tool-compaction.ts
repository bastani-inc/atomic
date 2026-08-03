import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { estimateContextTokens, shouldCompact, type VerbatimCompactionResult } from "./compaction/index.ts";
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

	const hardInputLimit = model.contextWindow;
	const projectedTokens = estimateContextTokens(messages).tokens;
	if (!shouldCompact(projectedTokens, hardInputLimit, settings)) return messages;
	// Only a context that genuinely will not fit may clear a sub-minimum region.
	// The threshold sits at `contextWindow - reserveTokens`, well below the hard
	// limit, so a crossing alone is no reason to destroy context.
	const overHardLimit = hardInputLimit > 0 && projectedTokens > hardInputLimit;

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
	// Ownership publication and the synchronous `compaction_start` emission live
	// inside the cleanup scope: `_emit` runs subscribers synchronously, so a
	// throwing listener would otherwise leave `_autoCompactionAbortController`
	// and `_compactionReason` set with no `finally` to clear them. The next
	// threshold compaction would then be rejected as already active, and
	// attached clients would keep painting a compaction that never runs.
	try {
		this._autoCompactionAbortController = abortController;
		this._compactionReason = "threshold";
		this._emit({ type: "compaction_start", reason: "threshold", midTurn: true });

		const result = await this._applyVerbatimCompaction({
			resolvePlannerAuth: async (candidate) => {
				const auth = await this._getRequiredRequestAuth(candidate);
				return auth.apiKey || auth.headers ? auth : undefined;
			},
			abortController,
			backupLabel: "auto-compact",
			reason: "threshold",
			// Mid-turn: a compaction failure here kills the active turn.
			urgency: "load_bearing",
			...(overHardLimit ? { allowSmallRegion: true } : {}),
		});
		if (!result) {
			// Nothing was compactable and the projected context still fits, so the
			// follow-up request can be sent unchanged. That is a successful no-op,
			// not a failure: raising here is what killed the active turn.
			this._emit({
				type: "compaction_end",
				reason: "threshold",
				result: undefined,
				aborted: false,
				willRetry: false,
				midTurn: true,
			});
			return messages;
		}

		this._pendingPostToolCompactionGuard = { hardInputLimit, result };
		// `AgentState.messages` has an asymmetric accessor pair: the setter copies, the
		// getter hands back the live internal array. Returning it directly would make the
		// agent loop's `currentContext.messages` an alias of `agent.state.messages`, and
		// from the next turn on both writers (`runLoop` and the `message_end` reducer)
		// would append every message twice — duplicate `tool_result` blocks for one
		// `tool_use` id, which the provider rejects with an unrecoverable 400.
		return this.agent.state.messages.slice();
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
		if (this._compactionReason === "threshold") this._compactionReason = undefined;
	}
}

/** Gate the transformed message context immediately before provider conversion. */
export function _finishPostToolCompactionPreflight(this: AgentSession, messages: AgentMessage[]): AgentMessage[] {
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
