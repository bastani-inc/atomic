import { type Component, Container, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";
import type { ToolDefinition, ToolRenderContext } from "../../core/extensions/types.ts";
import { getTextOutput, replaceTabs, str } from "../../core/tools/render-utils.ts";
import { keyHintIfBound } from "../../modes/interactive/components/keybinding-hints.js";
import {
	collapseToolBlockLines,
	componentNeedsWorkingClock,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockGroup,
	ToolBlockRecords,
	type ToolBlockStatus,
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
/** Script lines a collapsed block shows, the header row's included. */
export const CODEMODE_SCRIPT_PREVIEW_LINES = 12;
const CALL_NAME = "codemode";
/** Script rows after the header start under the header's first script column, past `codemode(`. */
const SCRIPT_INDENT = " ".repeat(CALL_NAME.length + 1);

/** The script's rows: the header row's script text, and the rows under it. */
interface ScriptRows {
	readonly head: string;
	readonly body: readonly string[];
}

/**
 * The script as it reads: syntax-highlighted, closed by `)` once all of it shows. Collapsed, its first
 * {@link CODEMODE_SCRIPT_PREVIEW_LINES} lines, each cut at the width, then a hint naming the rest; expanded, every line,
 * wrapped. `headWidth` is the room the header row leaves for script text, `lineWidth` the room of the rows under it.
 */
function scriptRows(
	code: string | null,
	state: CodemodeRenderState,
	theme: Theme,
	expanded: boolean,
	headWidth: number,
	lineWidth: number,
): ScriptRows {
	if (code === null) return { head: `${theme.fg("error", "[invalid arg]")})`, body: [] };
	const display = terminalDisplayText(replaceTabs(code));
	const lines = display.split("\n");
	const shown = expanded ? lines : lines.slice(0, CODEMODE_SCRIPT_PREVIEW_LINES);
	const omitted = lines.length - shown.length;
	state.scriptHighlighter ??= new CodeHighlighter();
	const highlighted = state.scriptHighlighter.highlight(shown.join("\n"), "javascript");
	const styled = highlighted.length === shown.length ? [...highlighted] : [...shown];
	if (omitted === 0) styled[styled.length - 1] = `${styled[styled.length - 1] ?? ""})`;
	if (expanded) {
		const [first = "", ...rest] = styled;
		const [head = "", ...headRest] = wrapTextWithAnsi(first, Math.max(1, Math.min(headWidth, lineWidth)));
		const body = [...headRest, ...rest.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, lineWidth)))];
		return { head, body: body.map((line) => `${SCRIPT_INDENT}${line}`) };
	}
	const cut = (line: string, width: number, closed: boolean) =>
		closed
			? `${truncateToWidth(line.slice(0, -1), Math.max(0, width - 1), "…")})`
			: truncateToWidth(line, Math.max(0, width), "…");
	const last = styled.length - 1;
	const rows = styled.map((line, index) =>
		cut(line, index === 0 ? headWidth : lineWidth, omitted === 0 && index === last),
	);
	if (omitted > 0) {
		const hint = keyHintIfBound("app.tools.expand", "to expand");
		rows.push(theme.fg("dim", `… +${omitted} ${omitted === 1 ? "line" : "lines"}${hint ? ` (${hint})` : ""}`));
	}
	const [head = "", ...body] = rows;
	return { head, body: body.map((line) => `${SCRIPT_INDENT}${line}`) };
}

/**
 * The codemode block: `codemode(` and the script, its run time, and `details` under it. It reads the time when it
 * draws, so a running script's clock advances between updates.
 */
class CodemodeBlock implements Component {
	readonly toolBlockKind = "block";
	private readonly code: string | null;
	private readonly theme: Theme;
	private readonly context: ToolRenderContext;
	private readonly details: Component | undefined;
	constructor(code: string | null, theme: Theme, context: ToolRenderContext, details?: Component) {
		this.code = code;
		this.theme = theme;
		this.context = context;
		this.details = details;
	}
	private status(): ToolBlockStatus {
		return this.context.isPartial ? "running" : this.context.isError ? "failure" : "success";
	}
	isWorking(): boolean {
		return this.status() === "running" || componentNeedsWorkingClock(this.details);
	}
	invalidate(): void {
		this.details?.invalidate();
	}
	render(width: number): string[] {
		return width < 1 ? [] : this.new(width).render(width);
	}
	private new(width: number): ToolBlock {
		const context = this.context;
		const theme = this.theme;
		const elapsed = formatToolBlockElapsed(context.getElapsedMs?.() ?? context.durationMs, {
			isRunning: context.isPartial,
			subTenDecimal: false,
		});
		const meta = elapsed ? [elapsed] : [];
		const pad = Math.max(0, Math.min(Math.floor(context.outputPad), Math.floor(width) - 1));
		const contentWidth = Math.max(1, Math.floor(width) - pad);
		const name = `${theme.fg("toolTitle", theme.bold(CALL_NAME))}(`;
		const room = contentWidth - 2 - visibleWidth(name);
		const metaWidth = meta.reduce((total, part) => total + 3 + visibleWidth(part), 0);
		const script = scriptRows(
			this.code,
			context.state as CodemodeRenderState,
			theme,
			context.expanded,
			room - metaWidth,
			contentWidth - 2 - SCRIPT_INDENT.length,
		);
		const title: Component = {
			invalidate: () => {},
			render: (available) => [`${name}${truncateToWidth(script.head, Math.max(0, available - visibleWidth(name)))}`],
		};
		return new ToolBlock({
			status: this.status(),
			title,
			meta,
			body: script.body.length > 0 ? { invalidate: () => {}, render: () => [...script.body] } : undefined,
			details: this.details,
			outputPad: context.outputPad,
		});
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

/**
 * A nested call as a generic row: its tool's title and arguments, run time and status, and its error. It stands for a
 * call of a session saved before nested calls kept their blocks, or one whose block was over the limits.
 */
export function codemodeNestedCallBlock(
	call: CodemodeNestedCall,
	theme: Theme,
	expanded: boolean,
	cwd: string,
	outputPad = 0,
): ToolBlock {
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
		outputPad,
	});
}

export const codemodeRenderers: Pick<
	ToolDefinition<typeof codemodeSchema, CodemodeToolDetails>,
	"renderCall" | "renderResult"
> = {
	renderCall(args, theme, context) {
		return new CodemodeBlock(str(args?.code), theme, context);
	},
	renderResult(result, options, theme, context) {
		const records: Component[] = [];
		// A host that draws nested tool calls as blocks of their own leaves only the calls it does not draw here.
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
				new ToolBlockGroup(
					shown.map((call) => codemodeNestedCallBlock(call, theme, options.expanded, context.cwd)),
				),
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
		return new CodemodeBlock(
			str(context.args?.code),
			theme,
			context,
			records.length > 0 ? new ToolBlockRecords(records) : undefined,
		);
	},
};
