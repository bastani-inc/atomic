import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { hasOpenRun } from "./agent-session-prompt.ts";
import { abortTurnRetries } from "./agent-session-retry.ts";
import { settleTurnPause } from "./agent-session-turn-pause.ts";
import type { ClearedQueue, SessionAbortOptions } from "./agent-session-types.js";
import { cancelFirstPromptModel } from "./first-prompt-model.ts";

async function settlePauseAbortBoundaries(boundaries: readonly Promise<void>[]): Promise<void> {
	let throwFirstFailure: (() => never) | undefined;
	await Promise.all(
		boundaries.map(async (boundary) => {
			try {
				await boundary;
			} catch (error) {
				throwFirstFailure ??= () => {
					throw error;
				};
			}
		}),
	);
	throwFirstFailure?.();
}

/** Compose pause settlement without exposing an early rejection from one constituent. */
export function composePauseAbortBoundaries(
	boundaries: readonly (Promise<void> | undefined)[],
): Promise<void> | undefined {
	const pending = boundaries.filter((boundary): boundary is Promise<void> => boundary !== undefined);
	return pending.length === 0 ? undefined : settlePauseAbortBoundaries(pending);
}

/** Synchronously hold raw queue entries before pausing and aborting an active turn. */
export function pauseQueuedMessages(this: AgentSession): void {
	if (this._queuedMessagesPaused) return;
	this._queuedMessagesPaused = true;
	this._queuedMessagesPauseAbortBoundary = undefined;
	this._ensureActiveInterruptQueueHold();
}

/** Release a pause hold without starting a turn; report whether raw work was released. */
export async function resumeQueuedMessages(this: AgentSession, beforeRelease?: () => void): Promise<boolean> {
	if (!this._queuedMessagesPaused) return false;
	const abortBoundary = this._queuedMessagesPauseAbortBoundary;
	if (abortBoundary !== undefined) {
		try {
			await abortBoundary;
		} catch (error) {
			// Keep the hold closed across a failed abort. The rejecting explicit
			// resume observes that boundary and retires it so a later resume can retry.
			if (this._queuedMessagesPauseAbortBoundary === abortBoundary) {
				this._queuedMessagesPauseAbortBoundary = undefined;
			}
			throw error;
		}
	}
	if (this._pendingInterruptDeliveries > 0) await this._interruptDeliveryQueue;
	// An admitted-message recovery turn is a session-owned turn starter that begins
	// after the abort boundary settles. Releasing while it streams would let the
	// caller's follow-on prompt hit the streaming guard (issue #2362).
	const recoveryTurn = this._admittedRecoveryTurn;
	if (recoveryTurn !== undefined) await recoveryTurn;
	if (!this._queuedMessagesPaused) return false;
	beforeRelease?.();
	const hold = this._activeInterruptQueueHold;
	const released = hold !== undefined && (hold.steering.length > 0 || hold.followUp.length > 0);
	this._queuedMessagesPaused = false;
	this._agentRunAbortRequested = false;
	this._queuedMessagesPauseAbortBoundary = undefined;
	this._restoreAndClearActiveInterruptQueueHold();
	return released;
}

/** Abort an ordinary turn and synchronously publish its pause-associated settlement boundary. */
export function abort(this: AgentSession, options?: SessionAbortOptions): Promise<void> {
	// Establish the hold before aborting, as the TUI does, so dispose can save a queued protected notice (#5166).
	if (options?.pauseQueuedMessages) this.pauseQueuedMessages();
	this._extensionRunner.cancelHostInput();
	return abortCurrentGeneration.call(this);
}

/**
 * Interrupt the current turn the way a user's Esc does in a chat of a subagent: the run ends, but nothing is sealed
 * or held, so the session stays open for its next message, which starts a turn as usual. Between two attempts of a
 * retry nothing streams, and the interrupt cancels the retry, as Esc does in the main chat.
 */
export async function interruptTurn(this: AgentSession): Promise<void> {
	if (!this.isStreaming && !this.isRetrying) return;
	this._turnInterruptedByUser = true;
	this._awaitingMessageAfterInterrupt = false;
	this._extensionRunner.cancelHostInput();
	abortTurnRetries.call(this);
	if (this._isPreparingRun === "custom" && !this.agent.state.isStreaming) this._abortPreparedRunAtStart = true;
	this.agent.abort();
	await this.agent.waitForIdle();
	await this._agentEventQueue;
}

/**
 * Pause the current turn the way Esc does in a chat of a subagent, as Esc pauses the main chat: the messages the user
 * typed that are still queued come back (for the chat's editor), the turn ends as {@link interruptTurn} ends it, and the
 * session waits. What else is queued, such as another agent's message, is held, so nothing restarts the paused turn;
 * the next message, the user's or another agent's, releases it and starts the next turn (#5224).
 */
export async function pauseTurn(this: AgentSession): Promise<ClearedQueue> {
	// A run is open while its turn streams, waits to retry, or settles after it: each would deliver what is queued.
	const open = this.isStreaming || this.isRetrying || hasOpenRun(this);
	const holds = !this._queuedMessagesPaused;
	// The hold comes first, as in the main chat, so a message the ending run would deliver stays queued.
	if (holds) this.pauseQueuedMessages();
	const taken = this.clearQueue({ preserveUnprotectedCustomMessages: true });
	if (!holds) {
		// Already held, by an earlier pause or a stop: that hold's release stands; only a running turn still ends.
		if (this.isStreaming || this.isRetrying) await this.interruptTurn();
		return taken;
	}
	if (!open) {
		// No run to end: the rest stays queued for the next message, as it was.
		this._queuedMessagesPaused = false;
		this._restoreAndClearActiveInterruptQueueHold();
		return taken;
	}
	const settled = Promise.withResolvers<void>();
	this._turnPause = settled;
	// A release waits until the ended run has stopped reading the queue, as a resume waits for an abort to settle.
	this._queuedMessagesPauseAbortBoundary = settled.promise;
	this._turnInterruptedByUser = true;
	await this.interruptTurn();
	// A child's run settles in `settleSubagentMessages`; any other session's has once its turn ended.
	if (this._subagentMessageAdmission === undefined) settled.resolve();
	return taken;
}

/** Internal teardown never redirects cancellation into a replacement generation. */
export function abortCurrentGeneration(this: AgentSession): Promise<void> {
	cancelFirstPromptModel(this);
	this._extensionRunner.cancelHostInput();
	// A stop outlasts a pause: the next message no longer releases what the pause held.
	settleTurnPause(this);
	this._turnPause = undefined;
	this._agentRunAbortRequested = true;
	this._cacheWarmer?.cancel();
	this._postCompactionContinuationToken += 1;
	if (this._subagentMessageAdmission) {
		// Cancellation is terminal for a child. Hold even deliveries whose
		// protocol-safe persistence is still pending so they cannot restart it.
		this._subagentMessageAdmission.seal();
		// Unlike a priority interrupt's native abort, an explicit stop must also
		// block deferred input from starting a turn after preflight or settlement.
		this.pauseQueuedMessages();
	}
	abortTurnRetries.call(this);
	this._compactionAbortController?.abort();
	this._autoCompactionAbortController?.abort();
	this._branchSummaryAbortController?.abort();
	this.agent.abort();
	const manualCompaction = this._manualCompactionPromise;
	const automaticCompaction = this._autoCompactionCompletion;
	const branchSummary = this._branchSummaryCompletion;
	const boundary = (async () => {
		await this.agent.waitForIdle();
		await Promise.allSettled(
			[manualCompaction, automaticCompaction, branchSummary].filter((value) => value !== undefined),
		);
		await this._agentEventQueue;
	})();
	if (this._queuedMessagesPaused) {
		const tracked = composePauseAbortBoundaries([this._queuedMessagesPauseAbortBoundary, boundary]);
		if (tracked === undefined) return boundary;
		this._queuedMessagesPauseAbortBoundary = tracked;
		void tracked.catch(() => {});
	}
	return boundary;
}
