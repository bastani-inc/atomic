import { ATOMIC_WORKING_FRAME_MS, ATOMIC_WORKING_FRAMES } from "./atomic-working-status.ts";
import type { ChatSessionHostState } from "./chat-session-host-state.ts";
import { finalizeTerminalWorkflowToolEntries } from "./chat-session-host-terminal-cleanup.ts";
import type { ChatSessionSubmitMode } from "./chat-session-host-types.ts";
import { ANIMATION_FRAME_MS, STREAMING_RENDER_THROTTLE_MS } from "./chat-session-host-utils.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.ts";

export function isChatSessionStreaming<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): boolean {
	return !state.disposed && (state.sdkBusy || state.isStreamingOverride?.() === true);
}

export function isChatSessionBashRunning<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): boolean {
	return state.localBashRunning || state.isBashRunningOverride?.() === true;
}

export function incrementOptimisticUserSignature<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	signature: string,
): void {
	state.optimisticUserSignatureCounts.set(signature, (state.optimisticUserSignatureCounts.get(signature) ?? 0) + 1);
}

export function decrementOptimisticUserSignature<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	signature: string,
): void {
	const count = state.optimisticUserSignatureCounts.get(signature) ?? 0;
	if (count <= 1) state.optimisticUserSignatureCounts.delete(signature);
	else state.optimisticUserSignatureCounts.set(signature, count - 1);
}

export function startChatSessionWorkingLifecycle<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	if (state.disposed) return;
	clearChatSessionAnimation(state);
	clearChatSessionEventRender(state);
	state.immediateEventRenderPending = true;
	state.workingLifecycleActive = true;
	state.workingLifecycleGeneration += 1;
	state.workingFrame = 0;
}

export function stopChatSessionWorkingLifecycle<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	immediateEventRender = true,
): void {
	state.workingLifecycleActive = false;
	clearChatSessionAnimation(state);
	clearChatSessionEventRender(state);
	state.immediateEventRenderPending = !state.disposed && immediateEventRender;
}

/**
 * Begin a Working lifecycle for a prompt this host did not submit itself —
 * currently a workflow-authored `sendUserMessage()` accepted on an idle
 * retained stage. Mirrors the manual submit path so an accepted delivery paints
 * immediately and then hands the same visible period to the agent turn.
 *
 * Returns the lifecycle generation that identifies this delivery. Pass it back
 * to `settleChatSessionPromptLifecycle` so a stale settlement cannot clear a
 * newer turn.
 */
export function startChatSessionExternalPromptLifecycle<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): number | undefined {
	// Compaction status outranks ordinary Working and owns its own indicator.
	return openChatSessionExternalPromptLifecycle(state, state.compacting);
}

/**
 * Reopen the Working lifecycle for a delivery that is still active after a
 * temporary overlay ended — a pre-turn compaction clears busy state and the
 * lifecycle even though the accepted delivery has not started its turn yet.
 *
 * Unlike the initial start, this preserves `statusMessage` verbatim, so a
 * compaction error stays visible and keeps outranking ordinary Working.
 */
export function reassertChatSessionExternalPromptLifecycle<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): number | undefined {
	return openChatSessionExternalPromptLifecycle(state, true);
}

function openChatSessionExternalPromptLifecycle<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	preserveStatusMessage: boolean,
): number | undefined {
	if (state.disposed) return undefined;
	if (!preserveStatusMessage) state.statusMessage = "";
	state.sdkBusy = true;
	startChatSessionWorkingLifecycle(state);
	syncChatSessionAnimationTick(state);
	state.requestRender?.();
	return state.workingLifecycleGeneration;
}

/**
 * Settle a prompt lifecycle started by this host. A replaced generation means a
 * newer turn owns the indicator, so only its own owner may clear busy state.
 */
export function settleChatSessionPromptLifecycle<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	submittedGeneration: number | undefined,
): void {
	if (submittedGeneration === undefined) {
		state.sdkBusy = false;
		return;
	}
	const lifecycleWasReplaced = state.workingLifecycleGeneration !== submittedGeneration;
	if (lifecycleWasReplaced && state.workingLifecycleActive) return;
	state.sdkBusy = false;
	if (!lifecycleWasReplaced && !isChatSessionStreaming(state)) {
		stopChatSessionWorkingLifecycle(state);
	}
}

function clearChatSessionAnimation<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	if (!state.animationTimer) return;
	clearInterval(state.animationTimer);
	state.animationTimer = undefined;
}

function clearChatSessionEventRender<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	if (!state.renderThrottleTimer) return;
	clearTimeout(state.renderThrottleTimer);
	state.renderThrottleTimer = undefined;
}

export function syncChatSessionAnimationTick<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	const shouldAnimate =
		!state.disposed &&
		process.env.ATOMIC_REDUCED_MOTION !== "1" &&
		(state.workingLifecycleActive || state.compacting);
	if (shouldAnimate && !state.animationTimer) {
		const intervalMs =
			state.workingLifecycleActive || state.compacting ? ATOMIC_WORKING_FRAME_MS : ANIMATION_FRAME_MS;
		const timer = setInterval(() => {
			if (state.disposed || state.animationTimer !== timer || (!state.workingLifecycleActive && !state.compacting)) {
				return;
			}
			if (state.workingLifecycleActive || state.compacting) {
				state.workingFrame = (state.workingFrame + 1) % ATOMIC_WORKING_FRAMES.length;
			}
			state.requestRender?.();
		}, intervalMs);
		state.animationTimer = timer;
		state.animationTimer.unref?.();
		return;
	}
	if (!shouldAnimate) clearChatSessionAnimation(state);
}

export function clearChatSessionBusyForTerminalWorkflowStage<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	state.sdkBusy = false;
	state.workingMessage = undefined;
	state.compacting = false;
	stopChatSessionWorkingLifecycle(state, false);
	if (finalizeTerminalWorkflowToolEntries(state.transcript)) {
		state.transcriptComponent.invalidate();
	}
	state.liveChat.clearPendingTools();
	if (state.statusMessage !== state.lastWarningMessage) state.statusMessage = "";
	syncChatSessionAnimationTick(state);
}

export function disposeChatSession<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	state.disposed = true;
	state.compacting = false;
	stopChatSessionWorkingLifecycle(state, false);
	state.transcriptComponent.invalidate();
	state.editor = undefined;
}

export function notifyChatSessionWarning<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	message: string,
): void {
	state.statusMessage = message;
	state.showWarning?.(message);
	state.requestRender?.();
}

export function notifyChatSessionStatus<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	message: string,
): void {
	state.statusMessage = message;
	state.showStatus?.(message);
	state.requestRender?.();
}

/**
 * The prompt command is the one command that needs the submitting key's mode,
 * so it has its own accessor rather than a `text`-only signature that would
 * drop it.
 */
export function requiredChatSessionPromptCommand<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): (text: string, mode: ChatSessionSubmitMode) => Promise<void> {
	return async (text, mode) => {
		if (!state.commands.prompt) throw new Error("no prompt command configured for this chat session");
		await state.commands.prompt(text, mode);
	};
}

export function requiredChatSessionCommand<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	name: "steer" | "followUp" | "resume",
): (text?: string) => Promise<void> {
	switch (name) {
		case "steer":
			return async (text) => {
				if (!state.commands.steer) throw new Error("no steer command configured for this chat session");
				await state.commands.steer(text ?? "");
			};
		case "followUp":
			return async (text) => {
				if (!state.commands.followUp) throw new Error("no followUp command configured for this chat session");
				await state.commands.followUp(text ?? "");
			};
		case "resume":
			return async (text) => {
				if (!state.commands.resume) throw new Error("no resume command configured for this chat session");
				await state.commands.resume(text);
			};
	}
}

export function afterChatSessionEvent<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	changed: boolean,
): void {
	if (state.disposed) return;
	syncChatSessionAnimationTick(state);
	if (!changed) return;
	if (state.immediateEventRenderPending) {
		state.immediateEventRenderPending = false;
		state.requestRender?.();
		return;
	}
	requestChatSessionEventRender(state);
}

function requestChatSessionEventRender<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	if (!isChatSessionStreaming(state)) {
		state.requestRender?.();
		return;
	}
	if (state.animationTimer) return;
	if (state.renderThrottleTimer) return;
	const timer = setTimeout(() => {
		if (state.disposed || state.renderThrottleTimer !== timer) return;
		state.renderThrottleTimer = undefined;
		state.requestRender?.();
	}, STREAMING_RENDER_THROTTLE_MS);
	state.renderThrottleTimer = timer;
	state.renderThrottleTimer.unref?.();
}
