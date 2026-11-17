import { type Component, Container, Text } from "@bastani/atomic-tui";
import { builtinToolBlockPresentation } from "../../../modes/interactive/components/tool-block-families.ts";
import { CodeHighlighter, type Theme } from "../../../modes/interactive/theme/theme.js";
import { singleLineDisplayText } from "../../../utils/terminal-text.ts";
import type { ToolRenderContext, ToolRenderers } from "../../extensions/types.ts";
import type { TaskId } from "../../tasks/contracts.js";

const highlighters = new WeakMap<object, CodeHighlighter>();

function presentation(
	toolName: string,
	context: ToolRenderContext,
	result?: Parameters<NonNullable<ToolRenderers["renderResult"]>>[0],
	theme?: Pick<Theme, "fg" | "bold">,
) {
	const state = typeof context.state === "object" && context.state !== null ? context.state : undefined;
	let highlighter = state ? highlighters.get(state) : undefined;
	if (!highlighter) {
		highlighter = new CodeHighlighter();
		if (state) highlighters.set(state, highlighter);
	}
	return builtinToolBlockPresentation({
		toolName,
		args: context.args,
		result:
			result === undefined ? undefined : { ...result, isError: context.isError, durationMs: context.durationMs },
		expanded: context.expanded,
		isPartial: context.isPartial,
		cwd: context.cwd,
		executionStarted: context.executionStarted,
		argsComplete: context.argsComplete,
		elapsedMs: context.getElapsedMs?.() ?? context.durationMs,
		highlighter,
		theme,
		canManageTask: (taskId) => context.getTaskRecord?.(taskId as TaskId) !== undefined,
	});
}

export function builtinToolCallRenderer(toolName: string): NonNullable<ToolRenderers["renderCall"]> {
	return (args, theme, context): Component => {
		const view = presentation(toolName, { ...context, args }, undefined, theme);
		const title = theme.fg("toolTitle", theme.bold(view?.title ?? toolName));
		const argument = singleLineDisplayText(view?.args ?? "");
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		text.setText(`${title}${theme.fg("text", `(${argument})`)}`);
		return text;
	};
}

export function builtinToolResultRenderer(toolName: string): NonNullable<ToolRenderers["renderResult"]> {
	return (result, options, theme, context): Component =>
		presentation(toolName, { ...context, expanded: options.expanded, isPartial: options.isPartial }, result, theme)
			?.details ?? new Container();
}
