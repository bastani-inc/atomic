import type { ExtensionAPI } from "@bastani/atomic";
import { contextAgentDiscoveryOptions, discoverAgents } from "../agents/agents.js";
import type { SubagentState } from "../shared/types.js";
import { AgentBrowser } from "../tui/agent-browser.js";

/** The human catalog is separate from model-driven subagent execution. */
export function registerSlashCommands(atomic: ExtensionAPI, _state: SubagentState): void {
	atomic.registerCommand("agents", {
		description: "Browse available subagents and inspect their configuration",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Use subagent action=list to list agents outside interactive mode.", "info");
				return;
			}
			const { agents } = await discoverAgents(ctx.cwd, "both", contextAgentDiscoveryOptions(ctx));
			await ctx.ui.custom<void>(
				(tui, theme, _keys, done) => {
					const browser = new AgentBrowser(
						agents,
						theme,
						() => done(),
						() => tui.terminal.rows,
						args.trim(),
					);
					return browser;
				},
				{ purpose: "navigation" },
			);
		},
	});
}
