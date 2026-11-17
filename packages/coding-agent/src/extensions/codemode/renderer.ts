import { type Component, Container, Text, truncateToWidth } from "@bastani/atomic-tui";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput, replaceTabs, str } from "../../core/tools/render-utils.ts";
import { keyHintIfBound } from "../../modes/interactive/components/keybinding-hints.js";
import {
	collapseToolBlockLines,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockGroup,
	ToolBlockRecords,
} from "../../modes/interactive/components/tool-block.ts";
import {
	builtinToolBlockPresentation,
	formatToolBlockElapsed,
} from "../../modes/interactive/components/tool-block-families.ts";
import { CodeHighlighter, type Theme } from "../../modes/interactive/theme/theme.js";
import { singleLineDisplayText, terminalDisplayText } from "../../utils/terminal-text.ts";
import type { CodemodeNestedCall, CodemodeToolDetails, codemodeSchema } from "./tool.js";

interface CodemodeRenderState {
	scriptHighlighter?: CodeHighlighter;
}

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const NESTED_CALL_LIMIT = 8;

class CodemodeCall implements Component {
	private readonly code: string | null;
	private readonly theme: Theme;
	constructor(code: string | null, theme: Theme) {
		this.code = code;
		this.theme = theme;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		const code = this.code === null ? "[invalid arg]" : singleLineDisplayText(this.code.split("\n")[0]);
		const summary = `${code}${this.code?.includes("\n") ? "…" : ""}`;
		const name = this.theme.fg("toolTitle", this.theme.bold("codemode"));
		return [truncateToWidth(`${name}(${truncateToWidth(summary, Math.max(0, width - 10), "…")})`, width, "…")];
	}
}

function cost(value: number): string {
	return `$${value >= 0.01 ? value.toFixed(2) : value.toPrecision(2)}`;
}

function outputPreview(text: string, expanded: boolean): Component {
	const component = new Text(text, 0, 0);
	return {
		invalidate: () => component.invalidate(),
		render: (width) => collapseToolBlockLines(component.render(width), TOOL_BLOCK_LIMITS.bash, expanded),
	};
}

function nestedCall(call: CodemodeNestedCall, theme: Theme, expanded: boolean, cwd: string): ToolBlock {
	let args: unknown;
	try {
		args = JSON.parse(call.args);
	} catch {
		args = undefined;
	}
	const presentation = builtinToolBlockPresentation({
		toolName: call.name,
		args,
		expanded: false,
		isPartial: false,
		cwd,
		executionStarted: true,
		argsComplete: true,
	});
	const records: Component[] = [];
	if (expanded && call.args) records.push(new Text(terminalDisplayText(replaceTabs(call.args)), 0, 0));
	if (call.error)
		records.push(outputPreview(theme.fg("error", terminalDisplayText(replaceTabs(call.error))), expanded));
	const meta: string[] = [];
	const elapsed = formatToolBlockElapsed(call.durationMs, {
		isRunning: call.status === "running",
		subTenDecimal: call.name === "bash" || call.name === "fetch_content",
	});
	if (elapsed) meta.push(elapsed);
	if (call.cost !== undefined) meta.push(cost(call.cost));
	return new ToolBlock({
		status:
			call.status === "ok"
				? "success"
				: call.status === "error"
					? "failure"
					: call.status === "cancelled"
						? "stopped"
						: "running",
		title: presentation?.title ?? singleLineDisplayText(call.name),
		args: presentation?.args ?? singleLineDisplayText(call.args),
		meta,
		details: records.length ? new ToolBlockRecords(records) : undefined,
		outputPad: 0,
	});
}

export const codemodeRenderers: Pick<
	ToolDefinition<typeof codemodeSchema, CodemodeToolDetails>,
	"renderCall" | "renderResult"
> = {
	renderCall(args, theme) {
		return new CodemodeCall(str(args?.code), theme);
	},
	renderResult(result, options, theme, context) {
		const records: Component[] = [];
		const code = str(context.args?.code);
		if (options.expanded && code) {
			const state = context.state as CodemodeRenderState;
			state.scriptHighlighter ??= new CodeHighlighter();
			records.push(
				new Text(
					state.scriptHighlighter.highlight(terminalDisplayText(replaceTabs(code)), "javascript").join("\n"),
					0,
					0,
				),
			);
		}
		const calls = result.details?.calls ?? [];
		if (calls.length) {
			const shown = options.expanded ? calls : calls.slice(-NESTED_CALL_LIMIT);
			const nested = new Container();
			if (shown.length < calls.length) {
				const binding = keyHintIfBound("app.tools.expand", "to expand");
				nested.addChild(
					new Text(
						theme.fg("dim", `… +${calls.length - shown.length} earlier calls${binding ? ` (${binding})` : ""}`),
						0,
						0,
					),
				);
			}
			nested.addChild(
				new ToolBlockGroup(shown.map((call) => nestedCall(call, theme, options.expanded, context.cwd))),
			);
			records.push(nested);
			const priced = calls.filter((call) => call.cost !== undefined);
			if (priced.length > 1)
				records.push(
					new Text(
						theme.fg("muted", `Model calls: ${cost(priced.reduce((sum, call) => sum + (call.cost ?? 0), 0))}`),
						0,
						0,
					),
				);
		}
		const [first, ...rest] = result.content;
		const content = first?.type === "text" && SCRIPT_HEADER.test(first.text) ? rest : result.content;
		const output = options.isPartial ? "" : getTextOutput({ ...result, content }, context.showImages).trim();
		if (output) {
			const styled = terminalDisplayText(replaceTabs(output))
				.split("\n")
				.map((line) => theme.fg(context.isError ? "error" : "toolOutput", line))
				.join("\n");
			records.push(outputPreview(styled, options.expanded));
		}
		if (result.details?.fullOutputPath)
			records.push(
				new Text(theme.fg("muted", `Full output: ${terminalDisplayText(result.details.fullOutputPath)}`), 0, 0),
			);
		return new ToolBlockRecords(records);
	},
};
