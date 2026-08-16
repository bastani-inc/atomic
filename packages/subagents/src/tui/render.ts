/**
 * Rendering functions for subagent results.
 *
 * Public facade retained for existing imports; implementation is split by
 * rendering responsibility across sibling modules.
 */

export {
	currentRunningFrame,
	PULSE_FRAMES,
	pulseGlyph,
	RUNNING_ANIMATION_MS,
	RUNNING_FRAMES,
	runningPulseGlyph,
} from "./render-layout.js";
export { renderLiveSubagentResult, renderSubagentResult } from "./render-result.js";
export type { SubagentResultRenderState } from "./render-result-animation.js";
export {
	advanceResultPulseFrame,
	clearLegacyResultAnimationTimer,
	clearResultAnimationTimer,
	stopResultAnimations,
} from "./render-result-animation.js";
