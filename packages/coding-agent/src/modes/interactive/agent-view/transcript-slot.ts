// S-A (view) owns this module. C0 stub: nothing is drawn differently.
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import type { AgentViewSwitcher } from "./agent-view-switcher.ts";

/**
 * Draw the viewed subagent's transcript where the main transcript is, and main's again when main is shown. While a
 * subagent is shown, the mode's status, warning and error notices are drawn at the bottom of its transcript.
 * Answers the uninstall.
 */
export function installTranscriptSlot(_mode: InteractiveModeBase, _switcher: AgentViewSwitcher): () => void {
	return () => {};
}
