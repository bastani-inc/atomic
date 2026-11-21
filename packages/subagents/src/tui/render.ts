/**
 * Rendering functions for subagent results.
 *
 * Public facade retained for existing imports; implementation is split by
 * rendering responsibility across sibling modules.
 */

export { currentRunningFrame, RUNNING_ANIMATION_MS, RUNNING_FRAMES } from "./render-layout.js";
export { renderLiveSubagentResult, renderSubagentResult } from "./render-result.js";
export type { SubagentResultRenderState } from "./render-result-animation.js";
export {
	clearLegacyResultAnimationTimer,
	clearResultAnimationTimer,
	stopResultAnimations,
} from "./render-result-animation.js";
