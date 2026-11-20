// S-B (prompt) owns this module. C0 stub: commands are routed, everything else is sent as typed.
import { mainSubmit } from "../interactive-input-handling.ts";
import type { InteractiveModeBase } from "../interactive-mode-base.ts";
import type { AgentViewPort } from "./contracts.ts";
import { routeViewedCommand } from "./viewed-commands.ts";

/** What the prompt submits while a subagent is shown: `text` trimmed, `draft` as typed. */
export async function submitToViewedAgent(
	mode: InteractiveModeBase,
	port: AgentViewPort,
	text: string,
	draft: string,
): Promise<void> {
	const route = await routeViewedCommand(mode, port, text);
	if (route === "main") {
		await mainSubmit(mode, text, draft);
		return;
	}
	if (route === "handled") return;
	mode.editor.setText("");
	await port.steering.prompt(text);
}
