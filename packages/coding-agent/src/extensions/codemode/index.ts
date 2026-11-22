import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { CODEMODE_TOOL_NAME, createCodemodeToolDefinition, loadCodemodeRenderers } from "./tool.js";

export interface CodemodeExtensionOptions {
	mode?: CodemodeMode;
	inlineBudget?: number;
	models?: boolean;
}
export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			try {
				const hasCodemodeHistory = ctx.sessionManager
					.getEntries()
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolName === CODEMODE_TOOL_NAME,
					);
				if (hasCodemodeHistory) await loadCodemodeRenderers();
			} catch {
				// Partial context without sessionManager entries leaves renderer lazy.
			}
		});
		pi.registerTool(
			createCodemodeToolDefinition({
				models: options.models ?? true,
				appendEntry: (type, data) => pi.appendEntry(type, data),
				getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
				getToolGuidelines: () =>
					new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []] as const)),
				getMode: () =>
					options.mode ?? (pi.getSettings().codemode?.mode === "only" ? "only" : SETTINGS_DEFAULTS.codemode.mode),
				getInlineBudget: () => options.inlineBudget ?? pi.getSettings().codemode?.inlineBudget,
				getModelOnlyTools: () => {
					const active = new Set(pi.getActiveTools());
					return pi
						.getAllTools()
						.filter((tool) => tool.exposure === "model-only" && active.has(tool.name))
						.map((tool) => tool.name);
				},
			}),
		);
	};
}
export default createCodemodeExtension();
