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

const activeResultAnimationTimers = new Map<ResultAnimationTimer, SubagentResultRenderState>();

export function clearResultAnimationTimer(context: LegacyResultAnimationContext): void {
	const timer = context.state.subagentResultAnimationTimer;
	if (timer) {
		clearInterval(timer);
		activeResultAnimationTimers.delete(timer);
	}
	context.state.subagentResultAnimationTimer = undefined;
	context.state.subagentResultAnimationCleanup = undefined;
}

export function clearLegacyResultAnimationTimer(context: LegacyResultAnimationContext): void {
	clearResultAnimationTimer(context);
}

export function stopResultAnimations(): void {
	for (const [timer, state] of activeResultAnimationTimers) {
		clearInterval(timer);
		if (state.subagentResultAnimationTimer === timer) {
			state.subagentResultAnimationTimer = undefined;
			state.subagentResultAnimationCleanup = undefined;
		}
	}
	activeResultAnimationTimers.clear();
}
