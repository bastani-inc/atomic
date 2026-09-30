import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput, replaceTabs, str } from "../../core/tools/render-utils.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
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
		let text = theme.fg("toolTitle", theme.bold("codemode"));
		if (code === null) text += ` ${theme.fg("error", "[invalid arg]")}`;
		else if (code) {
			const lines = highlightCode(replaceTabs(code.replace(/\r/g, "").trimEnd()), "javascript");
			const shown = context.expanded ? lines : lines.slice(0, 10);
			text += `\n${shown.join("\n")}`;
			if (shown.length < lines.length) text += `\n${hint(theme, lines.length - shown.length, "lines")}`;
		}
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(text);
		return component;
	},
	renderResult(result, options, theme, context) {
		const sections: string[] = [];
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
			sections.push(lines.join("\n"));
		}
		const [first, ...rest] = result.content;
		const content = first?.type === "text" && SCRIPT_HEADER.test(first.text) ? rest : result.content;
		const output = options.isPartial ? "" : getTextOutput({ ...result, content }, context.showImages).trim();
		if (output) {
			const lines = replaceTabs(output).split("\n");
			const shown = options.expanded ? lines : lines.slice(0, 5);
			let text = shown.map((line) => theme.fg(context.isError ? "error" : "toolOutput", line)).join("\n");
			if (shown.length < lines.length) text += `\n${hint(theme, lines.length - shown.length, "lines")}`;
			if (result.details?.fullOutputPath && !options.expanded)
				text += `\n${theme.fg("muted", `Full output: ${result.details.fullOutputPath}`)}`;
			sections.push(text);
		}
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(sections.length ? `\n${sections.join("\n\n")}` : "");
		return component;
	},
};
