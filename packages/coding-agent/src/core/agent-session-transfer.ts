import {
	forwardWorkflowStageDeliveries,
	resolveWorkflowStageDeliveryTarget,
} from "./agent-session-delivery-forwarding.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { transferProtectedStreamingCustomMessages } from "./agent-session-persistent-custom-messages.ts";
import { composePauseAbortBoundaries } from "./agent-session-queue-pause.ts";
import { priorityHoldCounts } from "./agent-session-types.js";

/** Atomically retire one stage session and prepend all of its delivery ownership to the replacement. */
export function transferWorkflowStageDeliveriesTo(this: AgentSession, target: object): void {
	const requestedTarget = target as AgentSession;
	const source = forwardWorkflowStageDeliveries(this, requestedTarget);
	if (source === undefined) return;
	const next = resolveWorkflowStageDeliveryTarget(requestedTarget);
	// #3982: the stage runner re-sends its prompt to a replacement after retiring into it. Like a
	// fresh stage (#3919), turn-starting input that reaches it first is context for that prompt's
	// turn; a turn of its own would reject the runner's prompt with "Agent is already processing".
	if (next._activePromptCount === 0 && !next.isStreaming && !next._isPreparingRun)
		next._workflowStageAwaitingFirstPrompt = true;
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
	next._pendingCustomMessages.unshift(...source._pendingCustomMessages.splice(0));
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
		next._interruptDeliveryQueue = Promise.all([sourceInterruptQueue, targetInterruptQueue])
			.then(() => undefined)
			.catch(() => undefined);
	}
	next._activeInterruptQueueHold = undefined;
	const transferredAbortBoundary = composePauseAbortBoundaries([sourceAbortBoundary, targetAbortBoundary]);
	next._queuedMessagesPauseAbortBoundary = transferredAbortBoundary;
	if (transferredAbortBoundary !== undefined) void transferredAbortBoundary.catch(() => {});
	const remainsPaused = sourcePaused || targetPaused;
	next._queuedMessagesPaused = remainsPaused;
	if (remainsPaused || next._pendingInterruptDeliveries > 0) {
		// A transferred interrupt keeps exclusive ownership of the combined hold.
		// Its finalizer restores the hold only after the last live-owner delivery.
		next._activeInterruptQueueHold = transferred;
		// Keep the insertion boundary after older priority input, including a
		// replacement's own priority prefix behind the prepended source queues.
		const targetPriorityCount = priorityHoldCounts.get(targetHeld) ?? 0;
		priorityHoldCounts.set(
			transferred,
			targetPriorityCount > 0
				? sourceQueues.steering.length + targetPriorityCount
				: (priorityHoldCounts.get(sourceHeld) ?? 0),
		);
	} else {
		next._restoreQueuedAgentMessages(transferred);
	}
	source._emitQueueUpdate();
	next._emitQueueUpdate();
}
