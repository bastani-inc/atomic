// S-B (prompt) owns this module. C0 stub: commands are routed, everything else is sent as typed.
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import type { AgentViewPort } from "./contracts.ts";
import { routeViewedCommand } from "./viewed-commands.ts";

/** What the prompt submits while a subagent is shown: `text` trimmed, `draft` as typed. */
export async function submitToViewedAgent(
	mode: InteractiveModeBase,
	port: AgentViewPort,
	text: string,
	_draft: string,
): Promise<void> {
	const route = await routeViewedCommand(mode, port, text);
	if (route !== "agent") return;
	mode.editor.setText("");
	await port.steering.prompt(text);
}
