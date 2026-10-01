import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput, replaceTabs, str } from "../../core/tools/render-utils.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { VisualLinePreview } from "../../modes/interactive/components/visual-truncate.ts";
import { highlightCode, type Theme } from "../../modes/interactive/theme/theme.js";
import type { CodemodeNestedCall, CodemodeToolDetails, codemodeSchema } from "./tool.js";

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
function hint(theme: Theme, count: number, noun: string): string {
	return `${theme.fg("muted", `... (${count} more ${noun},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}
function cost(value: number): string {
	return `$${value >= 0.01 ? value.toFixed(2) : value.toPrecision(2)}`;
}
function formatCall(call: CodemodeNestedCall, theme: Theme, expanded: boolean): string {
	const icon =
		call.status === "running"
			? theme.fg("warning", "…")
			: call.status === "ok"
				? theme.fg("success", "✓")
				: call.status === "error"
					? theme.fg("error", "✗")
					: theme.fg("muted", "⊘");
	const args = !expanded && call.args.length > 80 ? `${call.args.slice(0, 77)}...` : call.args;
	let text = `${icon} ${theme.fg("toolTitle", call.name)}${args ? ` ${theme.fg("muted", args)}` : ""}`;
	if (call.durationMs !== undefined)
		text += ` ${theme.fg("dim", call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`)}`;
	if (call.cost) text += ` ${theme.fg("dim", cost(call.cost))}`;
	if (expanded && call.error) text += `\n    ${theme.fg("error", call.error.split("\n").join("\n    "))}`;
	return text;
}
export const codemodeRenderers: Pick<
	ToolDefinition<typeof codemodeSchema, CodemodeToolDetails>,
	"renderCall" | "renderResult"
> = {
	renderCall(args, theme, context) {
		const code = str(args?.code);
		const title = theme.fg("toolTitle", theme.bold("codemode"));
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		if (code === null) {
			component.addChild(new Text(`${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0));
			return component;
		}
		component.addChild(new Text(title, 0, 0));
		if (code) {
			const highlighted = highlightCode(replaceTabs(code.replace(/\r/g, "").trimEnd()), "javascript").join("\n");
			component.addChild(
				context.expanded
					? new Text(highlighted, 0, 0)
					: new VisualLinePreview({
							text: highlighted,
							maxVisualLines: 10,
							keep: "start",
							formatHint: (hidden) => hint(theme, hidden, "lines"),
						}),
			);
		}
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		const calls = result.details?.calls ?? [];
		if (calls.length) {
			const shown = options.expanded ? calls : calls.slice(-8);
			const lines = shown.map((call) => formatCall(call, theme, options.expanded));
			if (shown.length < calls.length) lines.unshift(hint(theme, calls.length - shown.length, "earlier calls"));
			const priced = calls.filter((call) => call.cost);
			if (priced.length > 1)
				lines.push(
					theme.fg("muted", `Model calls: ${cost(priced.reduce((sum, call) => sum + (call.cost ?? 0), 0))}`),
				);
			component.addChild(new Spacer(1));
			component.addChild(new Text(lines.join("\n"), 0, 0));
		}
		const [first, ...rest] = result.content;
		const content = first?.type === "text" && SCRIPT_HEADER.test(first.text) ? rest : result.content;
		const output = options.isPartial ? "" : getTextOutput({ ...result, content }, context.showImages).trim();
		if (output) {
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(context.isError ? "error" : "toolOutput", line))
				.join("\n");
			component.addChild(new Spacer(1));
			component.addChild(
				options.expanded
					? new Text(styled, 0, 0)
					: new VisualLinePreview({
							text: styled,
							maxVisualLines: 5,
							keep: "start",
							formatHint: (hidden) => hint(theme, hidden, "lines"),
						}),
			);
			if (result.details?.fullOutputPath && !options.expanded)
				component.addChild(new Text(theme.fg("muted", `Full output: ${result.details.fullOutputPath}`), 0, 0));
		}
		return component;
	},
};
