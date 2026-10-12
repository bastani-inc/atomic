import { resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

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
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) {
		owner.pauseQueuedMessages();
		return;
	}
	if (this._queuedMessagesPaused) return;
	this._queuedMessagesPaused = true;
	this._queuedMessagesPauseAbortBoundary = undefined;
	this._ensureActiveInterruptQueueHold();
}

/** Release a pause hold without starting a turn; report whether raw work was released. */
export async function resumeQueuedMessages(this: AgentSession, beforeRelease?: () => void): Promise<boolean> {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.resumeQueuedMessages(beforeRelease);
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
export function abort(this: AgentSession): Promise<void> {
	this._extensionRunner.cancelHostInput();
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.abort();
	return abortCurrentGeneration.call(this);
}

/** Internal teardown never redirects cancellation into a replacement generation. */
export function abortCurrentGeneration(this: AgentSession): Promise<void> {
	this._extensionRunner.cancelHostInput();
	this._agentRunAbortRequested = true;
	this._cacheWarmer?.cancel();
	this._postCompactionContinuationToken += 1;
	if (this._subagentMessageAdmission) {
		// Cancellation is terminal for a child. Hold even deliveries whose
		// protocol-safe persistence is still pending so they cannot restart it.
		this._subagentMessageAdmission.seal();
	}
	const ownsStageDeliveries = resolveWorkflowStageDeliveryTarget(this) === this;
	if ((this._subagentMessageAdmission || this._workflowStageAdmission) && ownsStageDeliveries) {
		// Unlike a priority interrupt's native abort, an explicit stop must also
		// block deferred input from starting a turn after preflight or settlement.
		// A stage's generation remains host-owned; only explicit resume releases it.
		this.pauseQueuedMessages();
	}
	this.abortRetry();
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
