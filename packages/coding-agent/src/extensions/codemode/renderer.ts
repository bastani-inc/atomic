import {
	type Component,
	Container,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput, replaceTabs, str } from "../../core/tools/render-utils.ts";
import { keyHintIfBound } from "../../modes/interactive/components/keybinding-hints.js";
import {
	collapseToolBlockLines,
	indentWithin,
	NARROWEST_INDENTED_TEXT,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockRecords,
	type ToolBlockTitleRows,
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

/** The script without the blank lines around it, made inert for the terminal. */
function scriptSource(code: string): string {
	return terminalDisplayText(replaceTabs(code.replace(/\r\n?/g, "\n")))
		.replace(/^(?:[ \t]*\n)+/, "")
		.trimEnd();
}

/**
 * A script line in rows of `width`: rows after the first hang under the line, two columns past its indent, without
 * leaving them narrower than a wide character. A character that does not fit at the end of a row starts the next one.
 */
function wrapScriptLine(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	const indent = /^ */.exec(stripTerminalSequences(line))?.[0].length ?? 0;
	const hang = indentWithin(width, Math.min(indent + 2, Math.floor(width / 2)));
	return wrapTextWithAnsi(line, width - hang).map((row, index) => (index === 0 ? row : `${" ".repeat(hang)}${row}`));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Stands for a character two columns wide on rows one column wide, where it cannot be drawn. */
export const WIDE_CHARACTER_PLACEHOLDER = "\uFFFD";

/** `text` with each character wider than one column replaced by {@link WIDE_CHARACTER_PLACEHOLDER}. */
function placeholdWideCharacters(text: string): string {
	let narrowed = "";
	for (const { segment } of graphemes.segment(text))
		narrowed += visibleWidth(segment) > 1 ? WIDE_CHARACTER_PLACEHOLDER : segment;
	return narrowed;
}

/**
 * The call with its script as the argument, highlighted as JavaScript. A one-line script stays on the title row:
 * collapsed it is cut to fit, expanded it moves under `codemode(` when it does not fit. A longer script opens
 * `codemode(`, shows its lines indented under it, and closes with `)`; collapsed shows the first lines, cut to the
 * width, and expanded shows every line, wrapped under itself.
 */
class CodemodeCall implements ToolBlockTitleRows {
	readonly toolBlockTitleRows = true;
	private readonly code: string | null;
	private readonly theme: Theme;
	private readonly expanded: boolean;
	private readonly highlighter: CodeHighlighter;
	constructor(code: string | null, theme: Theme, expanded: boolean, highlighter: CodeHighlighter) {
		this.code = code;
		this.theme = theme;
		this.expanded = expanded;
		this.highlighter = highlighter;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		const name = this.theme.fg("toolTitle", this.theme.bold("codemode"));
		const open = `${name}${this.theme.fg("text", "(")}`;
		const close = this.theme.fg("text", ")");
		const inlineWidth = Math.max(0, width - visibleWidth("codemode()"));
		if (this.code === null) return [truncateToWidth(`${open}[invalid arg]${close}`, width, "…")];
		// Under `codemode(`, the script is indented two columns unless that leaves it narrower than a wide character.
		const indent = indentWithin(width, 2);
		const codeWidth = Math.max(1, width - indent);
		// Rows one column wide cannot hold a wide character: it shows as a placeholder rather than not at all.
		const source =
			codeWidth < NARROWEST_INDENTED_TEXT
				? placeholdWideCharacters(scriptSource(this.code))
				: scriptSource(this.code);
		const lines = source ? this.highlighter.highlight(source, "javascript") : [];
		if (lines.length <= 1 && (!this.expanded || visibleWidth(lines[0] ?? "") <= inlineWidth))
			return [truncateToWidth(`${open}${truncateToWidth(lines[0] ?? "", inlineWidth, "…")}${close}`, width, "…")];
		const rows = this.expanded
			? lines.flatMap((line) => wrapScriptLine(line, codeWidth))
			: collapseToolBlockLines(
					lines.map((line) => truncateToWidth(line, codeWidth, "…")),
					TOOL_BLOCK_LIMITS.script,
					false,
				);
		const margin = " ".repeat(indent);
		return [open, ...rows.map((row) => `${margin}${row}`), close].map((row) => truncateToWidth(row, width, "…"));
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

type CodemodeRenderers = Pick<
	ToolDefinition<typeof codemodeSchema, CodemodeToolDetails>,
	"renderCall" | "renderResult"
>;

/**
 * Draws a codemode result: the calls the script made, their model costs, the output and where the full output is.
 * The chat omits the script header; a saved HTML page draws all text itself, without terminal wrapping.
 */
function codemodeResultRenderer(savedPage: boolean): NonNullable<CodemodeRenderers["renderResult"]> {
	return (result, options, theme, context) => {
		const records: Component[] = [];
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
			for (const call of shown) nested.addChild(nestedCall(call, theme, options.expanded, context.cwd));
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
		const content = savedPage
			? result.content.filter((block) => block.type !== "text")
			: first?.type === "text" && SCRIPT_HEADER.test(first.text)
				? rest
				: result.content;
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
	};
}

export const codemodeRenderers: CodemodeRenderers = {
	renderCall(args, theme, context) {
		const state = context.state as CodemodeRenderState;
		state.scriptHighlighter ??= new CodeHighlighter();
		return new CodemodeCall(str(args?.code), theme, context.expanded, state.scriptHighlighter);
	},
	renderResult: codemodeResultRenderer(false),
};

/**
 * The call and nested activity for a saved session's export. The page adds the original result text and script header.
 */
export const savedCodemodeRenderers: CodemodeRenderers = {
	...codemodeRenderers,
	renderResult: codemodeResultRenderer(true),
};
