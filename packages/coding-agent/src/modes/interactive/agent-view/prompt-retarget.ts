// S-B (prompt) owns this module. C0 stub.
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import type { AgentViewSwitcher } from "./agent-view-switcher.ts";

/**
 * Retarget the main prompt to the shown agent: its draft, placeholder, top rule, queued rows, working line, history
 * and Esc. Answers the uninstall.
 */
export function installPromptRetarget(_mode: InteractiveModeBase, _switcher: AgentViewSwitcher): () => void {
	return () => {};
}
