type ResultAnimationTimer = ReturnType<typeof setInterval>;

export interface SubagentResultRenderState {
	subagentResultAnimationTimer?: ResultAnimationTimer;
	subagentResultAnimationCleanup?: () => void;
	subagentResultSnapshotKey?: string;
	/** Stable semantic/content timestamp used for durations and activity text. */
	subagentResultSnapshotNow?: number;
	/** Monotonic pulse frame, advanced once per progress update (no timer). */
	subagentResultPulseFrame?: number;
}

export type ResultAnimationContext = {
	state: SubagentResultRenderState;
	invalidate: () => void;
};
type LegacyResultAnimationContext = {
	state: {
		subagentResultAnimationTimer?: ResultAnimationTimer;
		subagentResultAnimationCleanup?: () => void;
	};
};

/**
 * Legacy safety net for render state objects created by earlier timer-driven
 * foreground result rendering. New code never schedules result timers, but
 * clearing the field prevents a stale interval from surviving across upgrades.
 */
export function clearResultAnimationTimer(context: LegacyResultAnimationContext): void {
	const timer = context.state.subagentResultAnimationTimer;
	if (timer) clearInterval(timer);
	context.state.subagentResultAnimationTimer = undefined;
	context.state.subagentResultAnimationCleanup = undefined;
}

export function advanceResultPulseFrame(frame: number | undefined): number {
	return (frame ?? 0) + 1;
}

export function clearLegacyResultAnimationTimer(context: LegacyResultAnimationContext): void {
	clearResultAnimationTimer(context);
}

export function stopResultAnimations(): void {
	// Retained for extension teardown compatibility; result rendering no longer
	// registers global animation timers.
}
