import { Text } from "@bastani/atomic-tui";
import type { ToolRenderers } from "../../../core/extensions/types.ts";
import { ToolBlock } from "./tool-block.ts";

export const RETAINED_TOOL_RENDERERS = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"search",
	"grep",
	"find",
	"ls",
	"todo",
	"wait",
	"kill",
	"intercom",
	"contact_supervisor",
	"subagent",
	"web_search",
	"fetch_content",
	"codemode",
	"ask_user_question",
]);

export function retainedToolRenderer(
	name: string,
	resolve: ((toolName: string) => ToolRenderers | undefined) | undefined,
): ToolRenderers | undefined {
	if (RETAINED_TOOL_RENDERERS.has(name)) return resolve?.(name);
	return unavailableToolRenderer(name);
}

export function unavailableToolRenderer(name: string): ToolRenderers {
	return {
		renderCall: (_args, _theme, context) =>
			new ToolBlock({
				status: "warning",
				title: name,
				args: "…",
				details: new Text("Tool renderer unavailable", 0, 0),
				outputPad: context.outputPad,
			}),
		renderResult: (_result, _options, _theme, context) =>
			new ToolBlock({
				status: "warning",
				title: name,
				args: "…",
				details: new Text("Tool renderer unavailable", 0, 0),
				outputPad: context.outputPad,
			}),
	};
}
