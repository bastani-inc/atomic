import type { ExtensionFactory } from "../../core/extensions/types.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { createCodemodeToolDefinition } from "./tool.js";

export interface CodemodeExtensionOptions {
	mode?: CodemodeMode;
	inlineBudget?: number;
	models?: boolean;
}
export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		pi.registerTool(
			createCodemodeToolDefinition({
				models: options.models ?? true,
				appendEntry: (type, data) => pi.appendEntry(type, data),
				getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
				getToolGuidelines: () =>
					new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []] as const)),
				getMode: () => options.mode ?? (pi.getSettings().codemode?.mode === "only" ? "only" : "on"),
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
