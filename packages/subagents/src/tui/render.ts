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
} from "./render-layout.ts";
export { renderLiveSubagentResult, renderSubagentResult } from "./render-result.ts";
export type { SubagentResultRenderState } from "./render-result-animation.ts";
export {
	advanceResultPulseFrame,
	clearLegacyResultAnimationTimer,
	clearResultAnimationTimer,
	stopResultAnimations,
} from "./render-result-animation.ts";
export { widgetRenderKey } from "./render-stable-output.ts";
export { buildWidgetLines, renderWidget, stopWidgetAnimation } from "./render-widget.ts";
