import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { createSessionAsyncDeliveryHandler } from "./async/session-manager.js";
import { forwardWorkflowStageDeliveries, resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import { transferProtectedStreamingCustomMessages } from "./agent-session-persistent-custom-messages.ts";
import { composePauseAbortBoundaries } from "./agent-session-queue-pause.ts";

/** Atomically retire one stage session and prepend all of its delivery ownership to the replacement. */
export function transferWorkflowStageDeliveriesTo(this: AgentSession, target: object): void {
	const requestedTarget = target as AgentSession;
	const source = forwardWorkflowStageDeliveries(this, requestedTarget);
	if (source === undefined) return;
	const next = resolveWorkflowStageDeliveryTarget(requestedTarget);
	const sourcePaused = source._queuedMessagesPaused;
	const targetPaused = next._queuedMessagesPaused;
	const sourceInterruptQueue = source._interruptDeliveryQueue;
	const targetInterruptQueue = next._interruptDeliveryQueue;
	const sourcePendingInterrupts = source._pendingInterruptDeliveries;
	const sourceLive = source._drainQueuedAgentMessages();
	const sourceAbortBoundary = source._queuedMessagesPauseAbortBoundary;
	const targetAbortBoundary = next._queuedMessagesPauseAbortBoundary;
	const targetLive = next._drainQueuedAgentMessages();
	const sourceHeld = source._activeInterruptQueueHold ?? { steering: [], followUp: [] };
	const targetHeld = next._activeInterruptQueueHold ?? { steering: [], followUp: [] };
	const sourceQueues = {
		steering: [...sourceHeld.steering, ...sourceLive.steering],
		followUp: [...sourceHeld.followUp, ...sourceLive.followUp],
	};
	const transferred = {
		steering: [...sourceQueues.steering, ...targetHeld.steering, ...targetLive.steering],
		followUp: [...sourceQueues.followUp, ...targetHeld.followUp, ...targetLive.followUp],
	};
	transferProtectedStreamingCustomMessages(source, next, sourceQueues);
	next._pendingNextTurnMessages.unshift(...source._pendingNextTurnMessages.splice(0));
	next._steeringMessages = [...source._steeringMessages.splice(0), ...next._steeringMessages];
	next._followUpMessages = [...source._followUpMessages.splice(0), ...next._followUpMessages];
	source._activeInterruptQueueHold = undefined;
	source._queuedMessagesPaused = false;
	source._queuedMessagesPauseAbortBoundary = undefined;
	source._pendingInterruptDeliveries = 0;
	if (sourcePendingInterrupts > 0) {
		next._pendingInterruptDeliveries += sourcePendingInterrupts;
		// Existing source and replacement deliveries may already be running. Future
		// interrupts and resume must wait for both settlement chains without making
		// the forwarded source callback wait on a chain that contains itself.
		next._interruptDeliveryQueue = Promise.all([
			sourceInterruptQueue,
			targetInterruptQueue,
		]).then(() => undefined).catch(() => undefined);
	}
	next._activeInterruptQueueHold = undefined;
	const transferredAbortBoundary = composePauseAbortBoundaries([
		sourceAbortBoundary,
		targetAbortBoundary,
	]);
	next._queuedMessagesPauseAbortBoundary = transferredAbortBoundary;
	if (transferredAbortBoundary !== undefined) void transferredAbortBoundary.catch(() => {});
	const remainsPaused = sourcePaused || targetPaused;
	next._queuedMessagesPaused = remainsPaused;
	if (remainsPaused || next._pendingInterruptDeliveries > 0) {
		// A transferred interrupt keeps exclusive ownership of the combined hold.
		// Its finalizer restores the hold only after the last live-owner delivery.
		next._activeInterruptQueueHold = transferred;
	} else {
		next._restoreQueuedAgentMessages(transferred);
	}
	source._emitQueueUpdate();
	next._emitQueueUpdate();
	source._asyncJobManager.transferSessionDeliveries(
		source._asyncJobManagerSessionId,
		next._asyncJobManagerSessionId,
		createSessionAsyncDeliveryHandler(next, next._asyncJobManager, next._asyncJobManagerSessionId),
	);
}
