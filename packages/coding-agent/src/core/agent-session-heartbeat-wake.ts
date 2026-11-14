import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { SendMessageOptions } from "./extensions/index.js";

/** Text the user typed but has not sent, still waiting in the queue or in an interrupt's hold. */
function holdsTypedInput(session: AgentSession): boolean {
	if (session.getSteeringMessages().length > 0 || session.getFollowUpMessages().length > 0) return true;
	const hold = session._activeInterruptQueueHold;
	return hold !== undefined && [...hold.steering, ...hold.followUp].some((message) => message.role === "user");
}

/**
 * #4795: an interrupt (Esc) pauses queued input until the user's next message. A heartbeat that arrives while the
 * chat sits idle in that pause resumes it, as that message would, so the heartbeat starts a turn at once. Input the
 * pause held goes with it into the same turn; the interrupted response is not replayed. A chat holding text the user
 * typed stays paused, so that text is never sent without them. Workflow-stage and subagent chats own their pauses.
 * Returns the resume to wait for before admitting the heartbeat, or nothing when there is none, so every other
 * delivery is admitted exactly when it was before.
 */
export function wakeIdleSessionForHeartbeat(
	session: AgentSession,
	options: SendMessageOptions | undefined,
): Promise<void> | undefined {
	if (options?.wakeIdleSession !== true || options.triggerTurn !== true || !session._queuedMessagesPaused) return;
	if (
		session._workflowStageAdmission ||
		session._subagentMessageAdmission ||
		(session._subagentPolicy?.depth ?? 0) >= 1
	)
		return;
	if (!session.settingsManager.getTaskHeartbeatWakesIdleSession()) return;
	// A chat paused by an interrupt whose abort is still settling is idle once that abort settles; resuming waits for it.
	const interrupted = session._queuedMessagesPauseAbortBoundary !== undefined;
	if (!interrupted && (session.isStreaming || session._isPreparingRun || session._activePromptCount > 0)) return;
	if (holdsTypedInput(session)) return;
	// Resuming first waits for the interrupt to settle; text typed meanwhile still keeps the chat paused.
	return session
		.resumeQueuedMessages(() => {
			if (holdsTypedInput(session)) throw new Error("Typed input keeps the chat paused");
		})
		.then(
			() => undefined,
			// Typed input, or a failed abort, keeps the pause; the heartbeat waits in it, as it would without the wake.
			() => undefined,
		);
}
