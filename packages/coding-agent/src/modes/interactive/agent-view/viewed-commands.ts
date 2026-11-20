// S-D (commands) owns this module. C0 stub: everything goes to the agent; no hotkey is gated.
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import type { AgentViewSwitcher } from "./agent-view-switcher.ts";
import type { AgentViewPort } from "./contracts.ts";

/**
 * Where a submission typed while a subagent is shown goes: `agent` (sent to it), `main` (the caller runs it as the
 * main chat would, through `mainSubmit`), or `handled` (refused, confirmed elsewhere, or run here).
 */
export type ViewedCommandRoute = "agent" | "main" | "handled";

export async function routeViewedCommand(
	_mode: InteractiveModeBase,
	_port: AgentViewPort,
	_text: string,
): Promise<ViewedCommandRoute> {
	return "agent";
}

/** Gate the hotkeys that act on the main conversation while a subagent is shown. Answers the uninstall. */
export function installViewedCommandGates(_mode: InteractiveModeBase, _switcher: AgentViewSwitcher): () => void {
	return () => {};
}

/** Double Esc on an empty prompt while a subagent is shown: the main chat's tree or fork selector, after a confirm. */
export function runViewedDoubleEscapeAction(mode: InteractiveModeBase, action: "tree" | "fork"): void {
	void (action === "tree" ? mode.showTreeSelector() : mode.showUserMessageSelector());
}
