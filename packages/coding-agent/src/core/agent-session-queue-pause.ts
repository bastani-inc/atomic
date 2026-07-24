import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";

async function settlePauseAbortBoundaries(boundaries: readonly Promise<void>[]): Promise<void> {
	let throwFirstFailure: (() => never) | undefined;
	await Promise.all(boundaries.map(async (boundary) => {
		try {
			await boundary;
		} catch (error) {
			throwFirstFailure ??= () => { throw error; };
		}
	}));
	throwFirstFailure?.();
}

/** Compose pause settlement without exposing an early rejection from one constituent. */
export function composePauseAbortBoundaries(
	boundaries: readonly (Promise<void> | undefined)[],
): Promise<void> | undefined {
	const pending = boundaries.filter(
		(boundary): boundary is Promise<void> => boundary !== undefined,
	);
	return pending.length === 0 ? undefined : settlePauseAbortBoundaries(pending);
}

/** Synchronously hold raw queue entries before pausing and aborting an active turn. */
export function pauseQueuedMessages(this: AgentSession): void {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.pauseQueuedMessages();
	if (this._queuedMessagesPaused) return;
	this._queuedMessagesPaused = true;
	this._queuedMessagesPauseAbortBoundary = undefined;
	this._ensureActiveInterruptQueueHold();
}

/** Release a pause hold without starting a turn; report whether raw work was released. */
export async function resumeQueuedMessages(this: AgentSession): Promise<boolean> {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.resumeQueuedMessages();
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
	if (!this._queuedMessagesPaused) return false;
	const hold = this._activeInterruptQueueHold;
	const released = hold !== undefined && (hold.steering.length > 0 || hold.followUp.length > 0);
	this._queuedMessagesPaused = false;
	this._queuedMessagesPauseAbortBoundary = undefined;
	this._restoreAndClearActiveInterruptQueueHold();
	return released;
}

/** Abort an ordinary turn and synchronously publish its pause-associated settlement boundary. */
export function abort(this: AgentSession): Promise<void> {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.abort();
	this.abortRetry();
	this.agent.abort();
	const boundary = (async () => {
		await this.agent.waitForIdle();
		await this._agentEventQueue;
	})();
	if (this._queuedMessagesPaused) {
		const tracked = composePauseAbortBoundaries([
			this._queuedMessagesPauseAbortBoundary,
			boundary,
		]);
		if (tracked === undefined) return boundary;
		this._queuedMessagesPauseAbortBoundary = tracked;
		void tracked.catch(() => {});
	}
	return boundary;
}
