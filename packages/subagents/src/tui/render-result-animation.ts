import { RUNNING_ANIMATION_MS } from "./render-layout.ts";

type ResultAnimationTimer = ReturnType<typeof setInterval>;

export interface SubagentResultRenderState {
	subagentResultAnimationTimer?: ResultAnimationTimer;
	subagentResultSnapshotKey?: string;
	/** Stable semantic/content timestamp used for durations and activity text. */
	subagentResultSnapshotNow?: number;
	/** Timer-driven timestamp used only for spinner glyph frames. */
	subagentResultSpinnerFrameNow?: number;
}

export type ResultAnimationContext = {
	state: SubagentResultRenderState;
	invalidate: () => void;
};
type LegacyResultAnimationContext = { state: { subagentResultAnimationTimer?: ResultAnimationTimer } };

const activeResultAnimationTimers = new Map<ResultAnimationTimer, SubagentResultRenderState>();

export function clearResultAnimationTimer(context: LegacyResultAnimationContext): void {
	const timer = context.state.subagentResultAnimationTimer;
	if (timer) {
		clearInterval(timer);
		activeResultAnimationTimers.delete(timer);
	}
	context.state.subagentResultAnimationTimer = undefined;
}

export function clearLegacyResultAnimationTimer(context: LegacyResultAnimationContext): void {
	clearResultAnimationTimer(context);
}

export function ensureResultAnimation(context: ResultAnimationContext): void {
	if (context.state.subagentResultAnimationTimer) return;
	const timer = setInterval(() => {
		context.state.subagentResultSpinnerFrameNow = Date.now();
		try {
			context.invalidate();
		} catch {
			clearResultAnimationTimer(context);
		}
	}, RUNNING_ANIMATION_MS);
	timer.unref?.();
	context.state.subagentResultAnimationTimer = timer;
	activeResultAnimationTimers.set(timer, context.state);
}

export function stopResultAnimations(): void {
	for (const [timer, state] of activeResultAnimationTimers) {
		clearInterval(timer);
		if (state.subagentResultAnimationTimer === timer) state.subagentResultAnimationTimer = undefined;
	}
	activeResultAnimationTimers.clear();
}
