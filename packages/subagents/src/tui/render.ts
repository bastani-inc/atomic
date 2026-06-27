/**
 * Rendering functions for subagent results.
 *
 * Public facade retained for existing imports; implementation is split by
 * rendering responsibility across sibling modules.
 */

export { RUNNING_ANIMATION_MS, currentRunningFrame, pulseGlyph } from "./render-layout.ts";
export {
	clearLegacyResultAnimationTimer,
	clearResultAnimationTimer,
	stopResultAnimations,
} from "./render-result-animation.ts";
export type { SubagentResultRenderState } from "./render-result-animation.ts";
export { widgetRenderKey } from "./render-stable-output.ts";
export { buildWidgetLines, renderWidget, stopWidgetAnimation } from "./render-widget.ts";
export { renderLiveSubagentResult, renderSubagentResult } from "./render-result.ts";
