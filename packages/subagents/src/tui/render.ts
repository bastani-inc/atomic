/**
 * Rendering functions for subagent results.
 *
 * Public facade retained for existing imports; implementation is split by
 * rendering responsibility across sibling modules.
 */

export { renderLiveSubagentResult, renderSubagentResult } from "./render-result.js";
export type { SubagentResultRenderState } from "./render-result-animation.js";
export {
	clearLegacyResultAnimationTimer,
	clearResultAnimationTimer,
	stopResultAnimations,
} from "./render-result-animation.js";
