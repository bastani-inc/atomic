import { atomicWorkingFrame, watchAtomicWorkingClock } from "./atomic-working-status.ts";
import { type ChatSessionHostState, isChatSessionRetryStatus } from "./chat-session-host-state.ts";
import type { ChatSessionSubmitMode } from "./chat-session-host-types.ts";
import type { ChatTranscriptEntryLike } from "./chat-transcript.js";

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
	state.workedRun = undefined;
	state.workingLifecycleActive = true;
	state.workingLifecycleGeneration += 1;
	state.workingFrame = atomicWorkingFrame();
}

export function stopChatSessionWorkingLifecycle<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	state.workingLifecycleActive = false;
	clearChatSessionAnimation(state);
}

/**
 * Begin a Working lifecycle for a prompt this host did not submit itself.
 * Mirrors the manual submit path so an accepted delivery paints
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
	if (!isChatSessionStreaming(state)) state.workingRunMeter.stop();
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
	const stopClock = state.stopAnimationClock;
	state.stopAnimationClock = undefined;
	stopClock?.();
	if (state.animationTimer !== undefined && typeof state.animationTimer !== "function") {
		clearInterval(state.animationTimer);
	}
	state.animationTimer = undefined;
	clearInterval(state.metaTimer);
	state.metaTimer = undefined;
}

/** Whether the chat's working line animates: a turn's, a compaction's, or a retry's, which counts down its wait. */
function chatSessionLineAnimates<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): boolean {
	return state.workingLifecycleActive || state.compacting || isChatSessionRetryStatus(state.statusMessage);
}

export function syncChatSessionAnimationTick<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	const active = !state.disposed && chatSessionLineAnimates(state);
	if (active && process.env.ATOMIC_REDUCED_MOTION === "1") {
		const stopClock = state.stopAnimationClock;
		state.stopAnimationClock = undefined;
		stopClock?.();
		if (state.animationTimer !== undefined && typeof state.animationTimer !== "function") {
			clearInterval(state.animationTimer);
		}
		state.animationTimer = undefined;
		if (state.metaTimer !== undefined) return;
		const timer = setInterval(() => {
			if (state.disposed || state.metaTimer !== timer || !chatSessionLineAnimates(state)) return;
			state.requestRender?.();
		}, 1000);
		state.metaTimer = timer;
		timer.unref?.();
		return;
	}
	clearInterval(state.metaTimer);
	state.metaTimer = undefined;
	if (active && !state.stopAnimationClock) {
		let subscribed = true;
		const unsubscribe = watchAtomicWorkingClock(() => {
			if (!subscribed || state.disposed || state.stopAnimationClock !== stop || !chatSessionLineAnimates(state)) {
				return;
			}
			state.workingFrame = atomicWorkingFrame();
			state.requestRender?.();
		});
		const stop = () => {
			if (!subscribed) return;
			subscribed = false;
			unsubscribe();
		};
		state.stopAnimationClock = stop;
		state.animationTimer = stop as unknown as ReturnType<typeof setInterval>;
		state.workingFrame = atomicWorkingFrame();
		return;
	}
	if (!active) clearChatSessionAnimation(state);
}

export function disposeChatSession<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
): void {
	state.disposed = true;
	state.footer?.dispose();
	state.footer = undefined;
	state.compacting = false;
	stopChatSessionWorkingLifecycle(state);
	state.extraEntries.length = 0;
	state.replaceTranscriptWindow([]);
	state.savedRenderers?.dispose();
	state.firstUserEntry = undefined;
	state.firstUserEntryExactText = undefined;
	state.optimisticUserSignatureCounts.clear();
	state.bodyViewport.dispose();
	state.editor = undefined;
}

export function notifyChatSessionWarning<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	message: string,
): void {
	state.noticeMessage = message;
	state.showWarning?.(message);
	state.requestRender?.();
}

export function notifyChatSessionStatus<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	message: string,
): void {
	state.noticeMessage = message;
	state.showStatus?.(message);
	state.requestRender?.();
}

/**
 * Prompt requires the submitting key's mode; resume accepts it optionally for
 * hosts that preserve submission intent across a pause.
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
): (text?: string, mode?: ChatSessionSubmitMode) => Promise<void> {
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
			return async (text, mode) => {
				if (!state.commands.resume) throw new Error("no resume command configured for this chat session");
				await state.commands.resume(text, mode);
			};
	}
}

/**
 * Paints what an event changed on the next frame, as the main chat does for every streamed delta. The renderer
 * coalesces requests into frames, so a burst of deltas still paints once per frame.
 */
export function afterChatSessionEvent<TExtraEntry extends ChatTranscriptEntryLike>(
	state: ChatSessionHostState<TExtraEntry>,
	changed: boolean,
): void {
	if (state.disposed) return;
	syncChatSessionAnimationTick(state);
	if (changed) state.requestRender?.();
}
