/**
 * Canonical session context boundaries.
 *
 * The SessionManager projection is the authoritative model context: every provider
 * request is built from it, recovery paths omit failed attempts through append-only
 * `context_edit` entries instead of slicing agent state, and extensions get two
 * actionable boundaries (`turn_end`, `agent_before_settle`) that may append entries and
 * request one explicit continuation.
 */

import type { AssistantMessage, ToolResultMessage } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { COMPACTION_AUTO_QUERY } from "./compaction/compaction-parameters.js";
import {
	DEFAULT_COMPRESSION_RATIO,
	DEFAULT_PRESERVE_RECENT,
	estimateProjectedContextTokens,
	serializeConversationForCompaction,
	VERBATIM_COMPACTION_PROMPT_VERSION,
	VERBATIM_COMPACTION_STRATEGY,
	type VerbatimCompactionDetails,
} from "./compaction/index.ts";
import type { AgentActivityOutcome, BoundaryContextPreview, SessionBoundaryDraft } from "./extensions/index.js";
import { convertToLlm, deferMessagesInterleavedWithToolBatch, repairOrphanToolResults } from "./messages.ts";
import { type SessionEntry, SessionManager } from "./session-manager.ts";

type BoundaryKind = "turn_end" | "agent_before_settle";

/**
 * Materialize the canonical projection as finalized context. Atomic repairs tool-call
 * pairing in derived context only (a resumed session may end on a tool call whose engine
 * died before recording its result) and applies the session's configured projection
 * transform; the durable transcript is never rewritten.
 */
export function _projectFinalizedMessages(this: AgentSession): AgentMessage[] {
	return finalizeProjectedMessages(this, projectSessionMessages(this));
}

function projectSessionMessages(session: AgentSession): AgentMessage[] {
	const projection = session.sessionManager.buildSessionProjection();
	for (const entry of projection.entries) {
		for (const message of entry.messages) session._entryIdsByMessage.set(message, entry.sourceEntry.id);
	}
	return projection.messages;
}

function finalizeProjectedMessages(session: AgentSession, messages: AgentMessage[]): AgentMessage[] {
	// While a run is active the loop owns pairing for the in-flight tool batch.
	const repaired = repairOrphanToolResults(deferMessagesInterleavedWithToolBatch(messages), {
		repairTrailing: !session.isStreaming,
	});
	return session._contextProjectionTransform ? session._contextProjectionTransform(repaired) : repaired;
}

/** Refresh the public finalized transcript from the canonical session projection. */
export function _refreshFinalizedContext(this: AgentSession): void {
	const unpersisted = this.agent.state.messages.filter((message) => this._messagesAwaitingPersistence.has(message));
	const projected = projectSessionMessages(this);
	this.agent.state.messages = finalizeProjectedMessages(
		this,
		unpersisted.length === 0 ? projected : [...projected, ...unpersisted],
	);
}

/** Refresh the public finalized transcript from the canonical session projection. */
export function refreshContext(this: AgentSession): void {
	this._refreshFinalizedContext();
}

/** Route every provider request through the canonical session projection. */
export function _installAgentRequestProjection(this: AgentSession): void {
	const previousPrepareRequest = this.agent.prepareRequest;
	this.agent.prepareRequest = async (request, signal) => {
		// Session listeners persist messages asynchronously; the projection is canonical
		// only once every queued event has been applied to the session manager. The whole
		// queue is the barrier, not just persistence: message_end handlers may replace the
		// message that gets persisted, and extension dispatch is serialized in event order,
		// so the last message_end cannot settle before earlier handlers. A failed listener
		// is reported through the queue's own recovery, never through the request.
		await this._agentEventQueue.catch(() => {});
		// Atomic honors a caller's complete replacement context from prepareNextTurnWithContext
		// for exactly the request it prepared.
		const callerReplaced = this._callerReplacedNextRequestContext;
		this._callerReplacedNextRequestContext = false;
		const canonicalContext = {
			...request.context,
			messages: callerReplaced ? request.context.messages : this._projectFinalizedMessages(),
			// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
			tools: this.agent.state.tools.slice(),
		};
		const previous = await previousPrepareRequest?.(
			{
				...request,
				context: canonicalContext,
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			},
			signal,
		);
		return {
			...previous,
			context: previous?.context ?? canonicalContext,
			model: previous?.model ?? this.agent.state.model,
			thinkingLevel: previous?.thinkingLevel ?? this.agent.state.thinkingLevel,
		};
	};
}

/** Dispatch the actionable `turn_end` boundary from `finishTurn`, before agent-core's own `turn_end`. */
export function _installAgentBoundaryHooks(this: AgentSession): void {
	const previousFinishTurn = this.agent.finishTurn;
	this.agent.finishTurn = async (turn, signal) => {
		this._boundaryDispatchedMessages.add(turn.message);
		const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults, true);
		const previousDecision = await previousFinishTurn?.(turn, signal);
		if (previousDecision?.action === "end") return previousDecision;
		if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
		return undefined;
	};
}

export async function _dispatchTurnEndBoundary(
	this: AgentSession,
	message: AssistantMessage,
	toolResults: ToolResultMessage[],
	awaitPersistence = false,
): Promise<boolean> {
	this._lastActivityOutcome =
		message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
	if (!this._extensionRunner.hasHandlers("turn_end")) return false;
	// The boundary resolves persisted entry IDs. From finishTurn, session listeners may
	// still be persisting this turn; from the serialized event queue they already have.
	if (awaitPersistence) await this._agentEventQueue.catch(() => {});
	const messageEntryId = this._findPersistedMessageEntryId(message);
	if (!messageEntryId) {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event: "turn_end",
			error: "turn_end could not resolve the persisted assistant entry ID",
		});
		return false;
	}
	const toolResultEntryIds = toolResults.flatMap((result) => {
		const entryId = this._findPersistedMessageEntryId(result);
		return entryId ? [entryId] : [];
	});
	const boundary = await this._extensionRunner.emitBoundary(
		{
			type: "turn_end",
			turnIndex: this._turnIndex,
			message,
			toolResults,
			messageEntryId,
			toolResultEntryIds,
			outcome: this._lastActivityOutcome,
		},
		(entries) => this._buildBoundaryContext(entries, "turn_end"),
	);
	this._commitBoundaryDrafts(boundary.entries);
	if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
		this._reportInvalidBoundaryContinuation("turn_end");
		return false;
	}
	return boundary.continue;
}

function extensionCompactionDetails(
	manager: SessionManager,
	summary: string,
	tokensBefore: number,
): VerbatimCompactionDetails {
	const linesBefore = serializeConversationForCompaction(
		convertToLlm(manager.buildSessionProjection().messages),
	).split("\n").length;
	const linesKept = summary.split("\n").length;
	const tokensAfter = Math.ceil(summary.length / 4);
	return {
		strategy: VERBATIM_COMPACTION_STRATEGY,
		promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
		parameters: {
			compression_ratio: DEFAULT_COMPRESSION_RATIO,
			preserve_recent: DEFAULT_PRESERVE_RECENT,
			query: COMPACTION_AUTO_QUERY,
		},
		stats: {
			linesBefore,
			linesDeleted: Math.max(0, linesBefore - linesKept),
			linesKept,
			rangeCount: 0,
			tokensBefore,
			tokensAfter,
			percentReduction: tokensBefore === 0 ? 0 : Math.round((1 - tokensAfter / tokensBefore) * 1000) / 10,
		},
		rung: "extension",
	};
}

export function _applyBoundaryDrafts(
	this: AgentSession,
	manager: SessionManager,
	drafts: SessionBoundaryDraft[],
): SessionEntry[] {
	const appended: SessionEntry[] = [];
	for (const draft of drafts) {
		let entryId: string;
		switch (draft.type) {
			case "custom":
				entryId = manager.appendCustomEntry(draft.customType, draft.data);
				break;
			case "custom_message":
				entryId = manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
				break;
			case "context_edit":
				entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
				break;
			case "compaction": {
				if (draft.summary.trim().length === 0) throw new Error("Compaction draft summary must not be empty");
				const tokensBefore = estimateProjectedContextTokens(
					manager.buildSessionProjection(),
					manager.getBranch(),
				).tokens;
				entryId = manager.appendCompaction(
					draft.summary,
					draft.firstKeptEntryId,
					tokensBefore,
					extensionCompactionDetails(manager, draft.summary, tokensBefore),
					draft.usage,
				);
				break;
			}
		}
		const entry = manager.getEntry(entryId);
		if (entry) appended.push(entry);
	}
	return appended;
}

export function _createBoundaryPreviewManager(this: AgentSession, drafts: SessionBoundaryDraft[]): SessionManager {
	const header = this.sessionManager.getHeader();
	if (!header) throw new Error("Session header is missing");
	const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
	this._applyBoundaryDrafts(manager, drafts);
	return manager;
}

export function _getPendingBoundaryMessages(this: AgentSession): AgentMessage[] {
	return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
}

export function _buildBoundaryContext(
	this: AgentSession,
	drafts: SessionBoundaryDraft[],
	boundary: BoundaryKind,
): BoundaryContextPreview {
	const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
	const contextMessages = finalizeProjectedMessages(this, projection.messages);
	const pendingMessages = this._getPendingBoundaryMessages();
	const llmMessages = convertToLlm(contextMessages);
	const finalRole = llmMessages[llmMessages.length - 1]?.role;
	const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
	const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
	const pendingCustomContext = this._pendingCustomMessages.length > 0;
	return {
		contextEntries: projection.entries,
		contextMessages,
		llmMessages,
		pendingMessages,
		canContinue:
			contextCanContinue ||
			pendingCustomContext ||
			(boundary === "turn_end"
				? this.agent.hasQueuedMessages()
				: finalRole === "assistant" && this.agent.hasQueuedMessages()),
	};
}

export function _commitBoundaryDrafts(this: AgentSession, drafts: SessionBoundaryDraft[]): void {
	const appended = this._applyBoundaryDrafts(this.sessionManager, drafts);
	this._refreshFinalizedContext();
	for (const entry of appended) this._emit({ type: "entry_appended", entry });
}

export function _reportInvalidBoundaryContinuation(this: AgentSession, event: BoundaryKind): void {
	this._extensionRunner.emitError({
		extensionPath: "<boundary>",
		event,
		error: `${event} requested continuation without runnable model context`,
	});
}

export function _findPersistedMessageEntryId(this: AgentSession, message: AgentMessage): string | undefined {
	const mapped = this._entryIdsByMessage.get(message);
	if (mapped) return mapped;
	for (const entry of [...this.sessionManager.getBranch()].reverse()) {
		if (entry.type === "message" && entry.message === message) return entry.id;
	}

	const messageIndex = this.agent.state.messages.indexOf(message);
	if (messageIndex < 0) return undefined;
	const projection = this.sessionManager.buildSessionProjection();
	let projectedIndex = 0;
	for (const entry of projection.entries) {
		for (let i = 0; i < entry.messages.length; i++) {
			if (projectedIndex === messageIndex) {
				this._entryIdsByMessage.set(message, entry.sourceEntry.id);
				return entry.sourceEntry.id;
			}
			projectedIndex++;
		}
	}
	return undefined;
}

/** Keep a failed attempt in raw history while durably omitting it from model projection. */
export function _omitRecoveryAttempt(
	this: AgentSession,
	message: AssistantMessage,
	toolResults: AgentMessage[] = [],
): void {
	const targets = [message, ...toolResults];
	const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
	const unresolvedProjectedTarget = targets.some(
		(target, index) => targetIds[index] === undefined && this.agent.state.messages.includes(target),
	);
	if (unresolvedProjectedTarget) {
		throw new Error("Cannot persist recovery omission because a projected message has no source entry");
	}
	for (const targetId of targetIds) {
		if (!targetId) continue;
		const editId = this.sessionManager.appendContextEdit(targetId, null);
		const entry = this.sessionManager.getEntry(editId);
		if (entry) this._emit({ type: "entry_appended", entry });
	}
	this._refreshFinalizedContext();
}

/**
 * Omit the trailing assistant attempt (and any tool results it produced) from model
 * projection when the loop must resume from the preceding input. Returns true when an
 * assistant attempt was omitted.
 */
export function _omitTrailingAssistantAttempt(
	this: AgentSession,
	accept: (message: AssistantMessage) => boolean = () => true,
): boolean {
	const messages = this.agent.state.messages;
	let index = messages.length - 1;
	const trailingToolResults: AgentMessage[] = [];
	while (index >= 0 && messages[index]?.role === "toolResult") {
		trailingToolResults.unshift(messages[index]);
		index--;
	}
	const candidate = messages[index];
	if (candidate?.role !== "assistant") return false;
	const assistant = candidate as AssistantMessage;
	if (!accept(assistant)) return false;
	this._omitRecoveryAttempt(assistant, trailingToolResults);
	return true;
}

/** Run the pre-settlement boundary. Returns true when the run must continue once more. */
export async function _runBeforeSettleBoundary(this: AgentSession): Promise<boolean> {
	if (!this._extensionRunner.hasHandlers("agent_before_settle")) return false;
	this._isBeforeSettle = true;
	this._abortDuringBeforeSettle = false;
	try {
		const result = await this._extensionRunner.emitBoundary(
			{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
			(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
		);
		this._commitBoundaryDrafts(result.entries);
		this._flushPendingCustomMessages();
		const finalContext = this._buildBoundaryContext([], "agent_before_settle");
		if (this._abortDuringBeforeSettle) return false;
		const shouldContinue = result.continue || this.agent.hasQueuedMessages();
		if (shouldContinue && !finalContext.canContinue) {
			if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
			return false;
		}
		return shouldContinue;
	} finally {
		this._isBeforeSettle = false;
	}
}

export const agentSessionBoundaryMethods = {
	_refreshFinalizedContext,
	_projectFinalizedMessages,
	refreshContext,
	_installAgentRequestProjection,
	_installAgentBoundaryHooks,
	_dispatchTurnEndBoundary,
	_applyBoundaryDrafts,
	_createBoundaryPreviewManager,
	_getPendingBoundaryMessages,
	_buildBoundaryContext,
	_commitBoundaryDrafts,
	_reportInvalidBoundaryContinuation,
	_findPersistedMessageEntryId,
	_omitRecoveryAttempt,
	_omitTrailingAssistantAttempt,
	_runBeforeSettleBoundary,
};

export type { AgentActivityOutcome };
